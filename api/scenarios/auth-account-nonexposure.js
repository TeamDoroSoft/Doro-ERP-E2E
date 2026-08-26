import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, header, parseProblem } from '../lib/http.js'
import { randomToken } from '../lib/provisioning.js'
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

// AUTH-015 본체 — 틀린 비밀번호 5회로 계정을 잠근 뒤(멱등: 이미 잠겨 있어도 안전) 정확한
// 비밀번호로 "안전하게 거절되는지"를 확인한다. 정적 계정(AUTH_LOCKOUT_01) 경로와 Provisioning
// 1회용 Fixture 경로가 이 로직을 공유한다 — auth-lockout-ratelimit.js의 AUTH-031과 같은 이유로
// 401/429 둘 다 안전한 거절로 인정한다(계정 Rate Limit Bucket 리필과 잠금 만료가 같은 주기라
// "Bucket은 찼는데 잠금은 안 풀린" 구간이 사실상 없다 — 실측 확인).
function runLockoutNonDisclosureCheck(env, loginUrl, startedAt, t0, tenantCode, loginId, correctPassword) {
  for (let i = 0; i < 5; i++) {
    postJson(loginUrl, { tenantCode, loginId, password: `wrong-${i}` }, { jar: freshJar() })
  }

  const res = postJson(loginUrl, { tenantCode, loginId, password: correctPassword }, { jar: freshJar() })
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

  // AUTH-013/014/015는 실 배포 대상 테넌트 DB에 Provisioning API로 계정을 만들지 않는다 —
  // 미리 만들어둔 정적 계정만 쓴다(Docs/Specifications/운영·배포/
  // "배포 검증용 테스트 계정 요청.md" 참고). 없으면 SKIP_PRECONDITION.
  if (env.staticAccounts.inactiveEmployee) {
    group('AUTH-013: INACTIVE 직원 + 정확한 비밀번호 (정적 계정)', () => {
      const startedAt = new Date().toISOString()
      const t0 = Date.now()
      const { tenantCode, loginId, password } = env.staticAccounts.inactiveEmployee
      const res = postJson(loginUrl, { tenantCode, loginId, password }, { jar: freshJar() })
      recordNonDisclosure(env, 'AUTH-013', startedAt, t0, res, {})
    })
  } else {
    recordSkip(env, 'AUTH-013', 'AUTH_INACTIVE_EMPLOYEE_01 정적 계정 없음 — INACTIVE 직원 Fixture 준비 불가')
  }

  if (env.staticAccounts.inactiveTenant) {
    group('AUTH-014: INACTIVE 테넌트/매장의 정상 계정 (정적 계정)', () => {
      const startedAt = new Date().toISOString()
      const t0 = Date.now()
      const { tenantCode, loginId, password } = env.staticAccounts.inactiveTenant
      const res = postJson(loginUrl, { tenantCode, loginId, password }, { jar: freshJar() })
      recordNonDisclosure(env, 'AUTH-014', startedAt, t0, res, {})
    })
  } else {
    recordSkip(env, 'AUTH-014', 'AUTH_INACTIVE_TENANT_01 정적 계정 없음 — INACTIVE 테넌트 Fixture 준비 불가')
  }

  // AUTH-015는 AUTH-030처럼 계정을 실제로 잠근다 — auth-lockout-ratelimit.js와 같은 안전장치
  // (RUN_DESTRUCTIVE_AUTH_TESTS=true)를 정적 계정 경로에서도 그대로 요구한다(실제로 계정을
  // 잠그는 행위 자체는 파괴적이라서다).
  if (__ENV[DESTRUCTIVE_FLAG] !== 'true') {
    recordSkip(env, 'AUTH-015', `${DESTRUCTIVE_FLAG}=true로 명시하지 않으면 실행하지 않음 (auth-lockout-ratelimit.js와 같은 안전장치 재사용)`)
  } else if (env.staticAccounts.lockout) {
    group('AUTH-015: 잠금 상태 + 정확한 비밀번호 (정적 계정)', () => {
      const startedAt = new Date().toISOString()
      const t0 = Date.now()
      const { tenantCode, loginId, password } = env.staticAccounts.lockout
      runLockoutNonDisclosureCheck(env, loginUrl, startedAt, t0, tenantCode, loginId, password)
    })
  } else {
    recordSkip(env, 'AUTH-015', 'AUTH_LOCKOUT_01 정적 계정 없음 — 잠금 전용 Fixture 준비 불가')
  }
}

// handleSummary()는 일부러 두지 않는다 — 다른 k6 시나리오와 같은 이유
// (api/lib/resultLogger.js 주석, api/README.md "결과물" 참고).
