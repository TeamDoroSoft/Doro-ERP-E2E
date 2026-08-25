import encoding from 'k6/encoding'
import http from 'k6/http'
import { postJson, patchJson, xsrfTokenFrom } from './http.js'

// SESS-004/005은 "임시 비밀번호로 막 로그인한 계정"이 필요하다. AUTH_VALID_01은 이미 영구
// 비밀번호 상태라 재사용할 수 없어서, 이 케이스 전용 1회용 테넌트+OWNER를 직접 만든다
// (scripts/provision-local-rehearsal-account.mjs와 같은 Provisioning API, k6에서 호출하는 버전).
//
// 이 호출은 의도적으로 선택적이다 — Provisioning 자격증명(STORE_ACCESS_PROVISIONING_USERNAME/
// PASSWORD)과 PROVISIONING_ORIGIN이 없으면 SESS-004/005를 SKIP_PRECONDITION으로 건너뛴다.
// 로컬 리허설처럼 우리가 소유한 Postgres에 1회용 테넌트를 만드는 건 안전하지만, 실제
// dev/stage AWS DB에 테스트가 알아서 테넌트를 만드는 건 다른 문제라 기본으로 켜두지 않는다.
export function provisioningAvailable(env) {
  return !!(env.provisioning.origin && env.provisioning.username && env.provisioning.password)
}

function authHeader(env) {
  return `Basic ${encoding.b64encode(`${env.provisioning.username}:${env.provisioning.password}`)}`
}

export function provisionThrowawayOwner(env, { tenantCode, tenantName, storeName, loginId, temporaryPassword }) {
  const headers = { 'Content-Type': 'application/json', Authorization: authHeader(env) }

  const tenantRes = http.post(
    `${env.provisioning.origin}/internal/v1/tenants`,
    JSON.stringify({ tenantCode, tenantName, storeName }),
    { headers },
  )
  if (tenantRes.status !== 200) {
    throw new Error(`1회용 테넌트 Provisioning 실패: HTTP ${tenantRes.status} — ${tenantRes.body}`)
  }
  const tenantId = tenantRes.json('tenantId')

  const ownerRes = http.post(
    `${env.provisioning.origin}/internal/v1/tenants/${tenantId}/first-owner`,
    JSON.stringify({ loginId, temporaryPassword }),
    { headers },
  )
  if (ownerRes.status !== 200) {
    throw new Error(`1회용 OWNER Provisioning 실패: HTTP ${ownerRes.status} — ${ownerRes.body}`)
  }

  return { tenantId }
}

// AUTH-013(INACTIVE 직원)·AUTH-014(INACTIVE 테넌트)가 쓰는 계정 상태 조작 헬퍼들. 전부 OWNER
// Session(jar)이 필요하고, EmployeeController의 create/status 변경은 "최근 재인증" 상태를
// 요구한다(recentReauthenticationChecker) — provisionThrowawayOwner로 로그인한 직후에
// 곧바로 이어 호출하면 자연히 만족된다.

export function createEmployee(env, jar, { loginId, temporaryPassword, role }) {
  const url = `${env.apiOrigin}/api/v1/employees`
  const res = postJson(
    url,
    { loginId, temporaryPassword, role },
    { jar, headers: { 'X-XSRF-TOKEN': xsrfTokenFrom(jar, url), 'Idempotency-Key': randomToken() } },
  )
  if (res.status !== 200) {
    throw new Error(`직원 생성 실패: HTTP ${res.status} — ${res.body}`)
  }
  return res.json()
}

export function changeEmployeeStatus(env, jar, employeeId, status) {
  const url = `${env.apiOrigin}/api/v1/employees/${employeeId}/status`
  const res = patchJson(url, { status }, { jar, headers: { 'X-XSRF-TOKEN': xsrfTokenFrom(jar, url) } })
  if (res.status !== 200) {
    throw new Error(`직원 상태 변경 실패: HTTP ${res.status} — ${res.body}`)
  }
  return res.json()
}

// changeOwnPassword(/employees/me/password)는 changeEmployeeStatus와 달리 "최근 재인증"을
// 요구하지 않는다(EmployeeController 확인 완료) — SESS-004/005가 이미 같은 흐름을 실사용 중이다.
export function completePasswordChange(env, jar, currentPassword, newPassword) {
  const url = `${env.apiOrigin}/api/v1/employees/me/password`
  const res = patchJson(
    url,
    { currentPassword, newPassword },
    { jar, headers: { 'X-XSRF-TOKEN': xsrfTokenFrom(jar, url) } },
  )
  if (res.status !== 200) {
    throw new Error(`비밀번호 변경 실패: HTTP ${res.status} — ${res.body}`)
  }
  return res
}

// AUTH-014(INACTIVE 테넌트/매장)용 — Provisioning API(Basic Auth)라 Session이 아니라
// provisionThrowawayOwner와 같은 자격증명을 쓴다.
export function changeTenantStatus(env, tenantId, status) {
  const headers = { 'Content-Type': 'application/json', Authorization: authHeader(env) }
  const res = http.patch(
    `${env.provisioning.origin}/internal/v1/tenants/${tenantId}/status`,
    JSON.stringify({ status }),
    { headers },
  )
  if (res.status !== 200) {
    throw new Error(`테넌트 상태 변경 실패: HTTP ${res.status} — ${res.body}`)
  }
  return res
}

export function randomToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

// PasswordPolicyValidator.MIN_LENGTH = 15. 무작위 문자열이라 블록리스트·서비스 파생어 회피에
// 유리하다 (provision-local-rehearsal-account.mjs와 같은 접근).
export function randomPassword(prefix) {
  return `${prefix}-${randomToken()}`
}
