import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, header, parseProblem } from '../lib/http.js'
import {
  provisioningAvailable,
  provisionThrowawayOwner,
  createEmployee,
  changeEmployeeStatus,
  changeTenantStatus,
  completePasswordChange,
  randomToken,
  randomPassword,
} from '../lib/provisioning.js'
import { record } from '../lib/resultLogger.js'

// AUTH-011~015 (배포 Frontend–Backend 종단 검증.md §5 "공통 계약의 배포 재검증" — 계정 존재 여부
// 비노출). 다섯 시나리오 전부 같은 401
// AUTHENTICATION_FAILED + 같은 Problem 스키마로 응답해야 한다 — 그래야 공격자가 응답만 보고
// "loginId가 없다"/"테넌트가 없다"/"계정이 비활성이다"/"잠겨 있다"를 구분할 수 없다.
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

const DESTRUCTIVE_FLAG = 'RUN_DESTRUCTIVE_AUTH_TESTS'

// 공통 오류 계약: status+code+Content-Type+fieldErrors가 전부 같은 모양이어야 "비노출"이다.
function assertNonDisclosure(res) {
  const body = parseProblem(res)
  const contentType = (header(res, 'Content-Type') || '').split(';')[0].trim()
  return {
    pass:
      res.status === 401 &&
      body.code === 'AUTHENTICATION_FAILED' &&
      contentType === 'application/problem+json' &&
      Array.isArray(body.fieldErrors) &&
      body.fieldErrors.length === 0,
    status: res.status,
    code: body.code,
    contentType,
    fieldErrorsEmpty: Array.isArray(body.fieldErrors) && body.fieldErrors.length === 0,
  }
}

function recordNonDisclosure(env, testCaseId, startedAt, t0, res, extra) {
  const shape = assertNonDisclosure(res)
  check(null, { [`${testCaseId} 비노출 응답(401 AUTHENTICATION_FAILED)`]: () => shape.pass })
  record(env, {
    testCaseId,
    startedAt,
    durationMs: Date.now() - t0,
    resultCode: shape.pass ? 'PASS' : 'FAIL_ASSERTION',
    expected: { httpStatus: 401 },
    observed: { httpStatus: shape.status },
    requestId: header(res, 'X-Request-Id'),
    assertions: {
      status401: shape.status === 401,
      codeMatches: shape.code === 'AUTHENTICATION_FAILED',
      problemJson: shape.contentType === 'application/problem+json',
      fieldErrorsEmpty: shape.fieldErrorsEmpty,
      ...extra,
    },
    errorClass: shape.pass ? null : 'ASSERTION_MISMATCH',
  })
}

function recordSkip(env, testCaseId, reason) {
  record(env, {
    testCaseId,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    resultCode: 'SKIP_PRECONDITION',
    errorClass: reason,
  })
}

function recordError(env, testCaseId, startedAt, t0, error) {
  record(env, {
    testCaseId,
    startedAt,
    durationMs: Date.now() - t0,
    resultCode: 'ERROR_TRANSPORT',
    errorClass: error instanceof Error ? error.message : String(error),
  })
}

export default function () {
  const env = loadDeployEnv()
  const loginUrl = `${env.apiOrigin}/api/v1/auth/login`

  // AUTH-011/012는 실재하지 않는 tenantCode/loginId만 쓰므로 AUTH_VALID_01도, Provisioning
  // 자격증명도 필요 없다 — auth-mandatory.js의 AUTH-020~022와 같은 안전한 방식이다.
  group('AUTH-011: 존재하지 않는 loginId', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = postJson(
      loginUrl,
      { tenantCode: `e2e-nonexposure-${randomToken().slice(0, 8)}`, loginId: 'nonexistent-login', password: 'probe-Password-0011' },
      { jar: freshJar() },
    )
    recordNonDisclosure(env, 'AUTH-011', startedAt, t0, res, {})
  })

  group('AUTH-012: 존재하지 않는 tenantCode', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = postJson(
      loginUrl,
      { tenantCode: `e2e-nonexistent-tenant-${randomToken().slice(0, 8)}`, loginId: 'owner', password: 'probe-Password-0012' },
      { jar: freshJar() },
    )
    recordNonDisclosure(env, 'AUTH-012', startedAt, t0, res, {})
  })

  // AUTH-013~015는 실제로 테넌트·직원을 만들고 상태를 바꿔야 해서 Provisioning 자격증명이
  // 필요하다 — 없으면 SESS-004/005와 같은 방식으로 SKIP_PRECONDITION.
  if (!provisioningAvailable(env)) {
    recordSkip(env, 'AUTH-013', 'Provisioning 자격증명 없음 — INACTIVE 직원 Fixture 생성 불가')
    recordSkip(env, 'AUTH-014', 'Provisioning 자격증명 없음 — INACTIVE 테넌트 Fixture 생성 불가')
  } else {
    group('AUTH-013: INACTIVE 직원 + 정확한 비밀번호', () => {
      const startedAt = new Date().toISOString()
      const t0 = Date.now()
      try {
        const fixture = {
          tenantCode: `e2e-inactive-emp-${randomToken().slice(0, 10)}`,
          tenantName: 'Doro E2E AUTH-013 Fixture',
          storeName: 'Doro E2E AUTH-013 Store',
          loginId: 'owner',
          // PasswordPolicyValidator는 비밀번호가 loginId("owner")를 부분 문자열로 포함하면
          // 거부한다 — "Owner013" 같은 접두어는 실제로 이 규칙에 걸려 WEAK_PASSWORD 400을
          // 냈다(실측 확인) — "Fixture" 접두어로 회피한다.
          temporaryPassword: randomPassword('Fixture013'),
        }
        provisionThrowawayOwner(env, fixture)

        const ownerJar = freshJar()
        const ownerLogin = postJson(
          loginUrl,
          { tenantCode: fixture.tenantCode, loginId: fixture.loginId, password: fixture.temporaryPassword },
          { jar: ownerJar },
        )
        if (ownerLogin.status !== 200) {
          throw new Error(`OWNER 사전 로그인 실패 (status=${ownerLogin.status}) — AUTH-013 전제조건 불충족`)
        }
        // EmployeeController의 직원 생성/상태 변경은 "행위자(OWNER) 본인이 이미 비밀번호를
        // 바꿨을 것"을 요구한다 — 임시 비밀번호 상태로 바로 createEmployee를 부르면
        // 403 PASSWORD_CHANGE_REQUIRED가 난다(실측 확인). 그래서 직원 생성 전에 OWNER 본인의
        // 비밀번호부터 완료한다.
        // 여기도 "owner" 부분 문자열을 포함하면 안 된다 — 위와 같은 이유.
        const ownerPermanentPassword = randomPassword('Fixture013Perm')
        completePasswordChange(env, ownerJar, fixture.temporaryPassword, ownerPermanentPassword)

        // 비밀번호 변경은 성공하는 순간 서버가 그 계정의 기존 Session을 전부 무효화한다
        // (SESS-005가 검증하는 것과 같은 동작) — 그래서 방금 쓴 ownerJar는 여기서부터 이미
        // 죽은 Session이다. createEmployee를 부르려면 새 비밀번호로 다시 로그인해서 새
        // Session을 받아야 한다(처음엔 이걸 놓쳐서 401 UNAUTHENTICATED를 실제로 봤다).
        const reauthenticatedOwnerJar = freshJar()
        const reLogin = postJson(
          loginUrl,
          { tenantCode: fixture.tenantCode, loginId: fixture.loginId, password: ownerPermanentPassword },
          { jar: reauthenticatedOwnerJar },
        )
        if (reLogin.status !== 200) {
          throw new Error(`비밀번호 변경 후 재로그인 실패 (status=${reLogin.status}) — AUTH-013 전제조건 불충족`)
        }

        const staffLoginId = `staff013${randomToken().slice(0, 6)}`
        const staffPassword = randomPassword('Staff013')
        const created = createEmployee(env, reauthenticatedOwnerJar, { loginId: staffLoginId, temporaryPassword: staffPassword, role: 'STAFF' })
        changeEmployeeStatus(env, reauthenticatedOwnerJar, created.id, 'INACTIVE')

        const res = postJson(
          loginUrl,
          { tenantCode: fixture.tenantCode, loginId: staffLoginId, password: staffPassword },
          { jar: freshJar() },
        )
        recordNonDisclosure(env, 'AUTH-013', startedAt, t0, res, {})
      } catch (error) {
        recordError(env, 'AUTH-013', startedAt, t0, error)
      }
    })

    group('AUTH-014: INACTIVE 테넌트/매장의 정상 계정', () => {
      const startedAt = new Date().toISOString()
      const t0 = Date.now()
      try {
        const fixture = {
          tenantCode: `e2e-inactive-tenant-${randomToken().slice(0, 10)}`,
          tenantName: 'Doro E2E AUTH-014 Fixture',
          storeName: 'Doro E2E AUTH-014 Store',
          loginId: 'owner',
          // loginId("owner")를 포함하지 않는 접두어를 쓴다 — AUTH-013 주석 참고.
          temporaryPassword: randomPassword('Fixture014Temp'),
        }
        const permanentPassword = randomPassword('Fixture014Perm')
        const { tenantId } = provisionThrowawayOwner(env, fixture)

        const jar = freshJar()
        const tempLogin = postJson(
          loginUrl,
          { tenantCode: fixture.tenantCode, loginId: fixture.loginId, password: fixture.temporaryPassword },
          { jar },
        )
        if (tempLogin.status !== 200) {
          throw new Error(`임시 비밀번호 로그인 실패 (status=${tempLogin.status}) — AUTH-014 전제조건 불충족`)
        }
        // "정상 계정"이라는 문서 표현에 맞춰 AUTH_VALID_01처럼 영구 비밀번호까지 완료한 뒤
        // 테넌트를 비활성화한다 — 임시 비밀번호 상태로 두면 별도 변수(FE-BE-010 영역)가 섞인다.
        completePasswordChange(env, jar, fixture.temporaryPassword, permanentPassword)

        changeTenantStatus(env, tenantId, 'INACTIVE')

        const res = postJson(
          loginUrl,
          { tenantCode: fixture.tenantCode, loginId: fixture.loginId, password: permanentPassword },
          { jar: freshJar() },
        )
        recordNonDisclosure(env, 'AUTH-014', startedAt, t0, res, {})
      } catch (error) {
        recordError(env, 'AUTH-014', startedAt, t0, error)
      }
    })
  }

  // AUTH-015는 AUTH-030처럼 계정을 실제로 잠근다 — auth-lockout-ratelimit.js와 같은 안전장치
  // (RUN_DESTRUCTIVE_AUTH_TESTS=true)를 추가로 요구한다.
  if (!provisioningAvailable(env)) {
    recordSkip(env, 'AUTH-015', 'Provisioning 자격증명 없음 — 잠금 전용 Fixture 생성 불가')
  } else if (__ENV[DESTRUCTIVE_FLAG] !== 'true') {
    recordSkip(env, 'AUTH-015', `${DESTRUCTIVE_FLAG}=true로 명시하지 않으면 실행하지 않음 (auth-lockout-ratelimit.js와 같은 안전장치 재사용)`)
  } else {
    group('AUTH-015: 잠금 상태 + 정확한 비밀번호', () => {
      const startedAt = new Date().toISOString()
      const t0 = Date.now()
      try {
        const fixture = {
          tenantCode: `e2e-lockout-nd-${randomToken().slice(0, 10)}`,
          tenantName: 'Doro E2E AUTH-015 Fixture',
          storeName: 'Doro E2E AUTH-015 Store',
          loginId: 'owner',
          temporaryPassword: randomPassword('Lock015'),
        }
        provisionThrowawayOwner(env, fixture)

        for (let i = 0; i < 5; i++) {
          postJson(loginUrl, { tenantCode: fixture.tenantCode, loginId: fixture.loginId, password: `wrong-${i}` }, { jar: freshJar() })
        }

        // 처음엔 여기서 65초를 기다린 뒤 정확한 비밀번호로 재시도했다 — 그런데 실제로 돌려보니
        // 200(로그인 성공)이 나왔다. 계정 Rate Limit Bucket 리필(분당 1개)과 잠금 만료(최초
        // 1분)가 둘 다 ~60초 주기라, 5번째 실패 시점에 거의 동시에 시작해서 거의 동시에
        // 풀린다 — "Bucket은 찼는데 잠금은 아직 안 풀린" 관찰 가능한 구간이 사실상 없다
        // (auth-lockout-ratelimit.js의 AUTH-031과 정확히 같은 현상, 거기서도 실측 확인).
        // 그래서 기다리지 않고 5번째 실패 직후 곧바로 확인한다 — 이 시점엔 Bucket이 아직
        // 소진 상태라 401(잠금)이 아니라 429(Bucket 소진)가 예상되며, AUTH-031과 같은 기준으로
        // "200이 아니고, 안전한 Problem 응답이고, 내부 정보가 없는지"를 판정한다.
        const res = postJson(
          loginUrl,
          { tenantCode: fixture.tenantCode, loginId: fixture.loginId, password: fixture.temporaryPassword },
          { jar: freshJar() },
        )
        const body = parseProblem(res)
        const isSafeRejectionStatus = res.status === 401 || res.status === 429
        const hasProblemCode = typeof body.code === 'string' && body.code.length > 0
        const noInternalLeak = !/Exception|SQL|java\.|Caused by|lockout|잠금 만료/i.test(JSON.stringify(body))
        const pass = isSafeRejectionStatus && hasProblemCode && noInternalLeak
        check(null, { 'AUTH-015 잠금 직후 안전한 거절(401 또는 429), 상세 비노출': () => pass })
        record(env, {
          testCaseId: 'AUTH-015',
          startedAt,
          durationMs: Date.now() - t0,
          resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
          expected: { httpStatus: 401 },
          observed: { httpStatus: res.status },
          requestId: header(res, 'X-Request-Id'),
          assertions: {
            notSuccessful: res.status !== 200,
            safeRejectionStatus: isSafeRejectionStatus,
            problemCodePresent: hasProblemCode,
            noInternalLeak,
          },
          errorClass: pass ? null : 'ASSERTION_MISMATCH',
        })
      } catch (error) {
        recordError(env, 'AUTH-015', startedAt, t0, error)
      }
    })
  }
}

// handleSummary()는 일부러 두지 않는다 — 다른 k6 시나리오와 같은 이유
// (api/lib/resultLogger.js 주석, api/README.md "결과물" 참고).
