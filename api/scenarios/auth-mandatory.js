import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, postRaw, getJson, header, cookieAttrs, parseProblem } from '../lib/http.js'
import { record } from '../lib/resultLogger.js'

// 기능 검증이 목적이라 부하 시나리오가 아니다 — 1 VU, 1 iteration으로 순서대로 한 번만 돈다.
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

// 이 스크립트가 다루는 필수 케이스 ID 목록. summary.json의 mandatoryApiPassed 계산에 필요한데,
// handleSummary()에서는 이 목록도 record()가 쌓은 결과도 볼 수 없으므로(§ 아래 handleSummary 관련
// 주석) 실행 뒤 `node api/lib/build-report.mjs <log> auth-mandatory AUTH-001,AUTH-002,...`처럼
// 인자로 넘긴다 — README 참고.
//
// 계정 Rate Limit Bucket(기본 용량 5회, 분당 1회 보충)을 이 스모크 하나로 소진하지
// 않도록 AUTH_VALID_01 실계정으로 로그인을 시도하는 케이스를 최소화한다.
//   - AUTH-001·AUTH-002·AUTH-024는 성공 스키마·RequestId Echo·위조 내부 Header 무시를
//     "같은 한 번의 성공 로그인 호출"에서 함께 검증한다.
//   - AUTH-003은 RequestId 미지정 케이스라 별도 호출이 필요하다.
//   - AUTH-004는 tenantCode 정규화 케이스라 별도 호출이 필요하다.
//   - AUTH-010은 유일한 실패 호출이다(잠금 임계치 5회에는 한참 못 미친다).
//   - AUTH-020~022는 요청 형식 검증이 계정 조회보다 먼저 일어난다는 전제로, 존재하지 않는
//     더미 tenantCode/loginId를 써서 AUTH_VALID_01의 Bucket을 건드리지 않는다.
//   - AUTH-023은 Method 자체가 GET이라 Edge가 Store Access까지 가지도 않고 503으로 막는다.
// 이렇게 해도 실계정 로그인 호출은 4회(001/002/024 병합 + 003 + 004 + 010)로, 이후 SESS-*
// 시나리오가 곧바로 이어 붙으면 5회째가 되어 용량 5의 경계에 걸린다. session-flow.js와
// 이 스크립트를 같은 1분 안에 연달아 돌리지 말 것 — README의 "Rate Limit 주의" 참고.
const DUMMY_TENANT = 'auth-validation-probe'
const DUMMY_LOGIN_ID = 'probe'

export default function () {
  const env = loadDeployEnv()
  const loginUrl = `${env.apiOrigin}/api/v1/auth/login`
  const account = env.authValid01

  group('AUTH-001 + AUTH-002 + AUTH-024: 성공 로그인 + RequestId Echo + 위조 내부 Header 무시', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const jar = freshJar()
    const suppliedRequestId = `req-doro-erp-e2e-${Date.now()}`

    const res = postJson(
      loginUrl,
      { tenantCode: account.tenantCode, loginId: account.loginId, password: account.password },
      {
        jar,
        headers: {
          'X-Request-Id': suppliedRequestId,
          // Edge가 실제로 Store Access에 보내는 내부 Header 이름과 같은 값을 외부 요청에
          // 실어 보낸다 (StoreAccessLoginForwarder.java 기준) — Edge가 이 값을 신뢰하지
          // 않고 자체 서명한 값으로 덮어써야 정상이다.
          'X-Doro-Actor-Type': 'OWNER',
          'X-Doro-Actor-Id': '00000000-0000-0000-0000-000000000000',
          'X-Doro-HMAC-Signature': 'forged-signature',
          'X-Doro-Caller-Service': 'not-edge',
          'X-Forwarded-For': '203.0.113.5',
        },
      },
    )

    const body = parseProblem(res)
    const requestId = header(res, 'X-Request-Id')
    const sessionCookie = cookieAttrs(res, 'SESSION')
    const xsrfCookie = cookieAttrs(res, 'XSRF-TOKEN')
    const cacheControl = header(res, 'Cache-Control') || ''

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const bodyOk =
      typeof body.employeeId === 'string' &&
      uuidRe.test(body.employeeId) &&
      ['OWNER', 'MANAGER', 'STAFF'].includes(body.role) &&
      typeof body.passwordChangeRequired === 'boolean'
    const cookiesOk =
      !!sessionCookie &&
      sessionCookie.secure === true &&
      sessionCookie.httpOnly === true &&
      sessionCookie.path === '/' &&
      !!xsrfCookie &&
      xsrfCookie.secure === true &&
      xsrfCookie.httpOnly === false &&
      xsrfCookie.path === '/'
    const noStore = cacheControl.toLowerCase().includes('no-store')
    const status200 = res.status === 200

    const auth001Pass = status200 && bodyOk && cookiesOk && noStore
    check(null, { 'AUTH-001 성공 응답 계약': () => auth001Pass })
    record(env, {
      testCaseId: 'AUTH-001',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: auth001Pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId,
      assertions: { status200, bodyOk, cookiesOk, noStore, sameSiteCheckable: sessionCookie?.sameSite !== null },
      errorClass: auth001Pass ? null : 'ASSERTION_MISMATCH',
    })

    const auth002Pass = status200 && requestId === suppliedRequestId
    check(null, { 'AUTH-002 RequestId Echo': () => auth002Pass })
    record(env, {
      testCaseId: 'AUTH-002',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: auth002Pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId,
      assertions: { requestIdEchoed: auth002Pass },
      errorClass: auth002Pass ? null : 'ASSERTION_MISMATCH',
    })

    // 이 케이스는 위조 X-Doro-Actor-Type: OWNER를 보냈을 때도 요청이 평소와 같은 정상
    // 200/스키마 응답으로 처리되는지만 본다("Header가 요청을 망가뜨리지 않는다"). 위조 값이
    // 실제로 권한 상승에 반영되지 않는다는 것까지 증명하려면 OWNER가 아닌 역할의 계정
    // Fixture로 같은 케이스를 반복해야 하는데, 지금은 그 Fixture가 없어 보류한다.
    const auth024Pass = status200 && bodyOk
    check(null, { 'AUTH-024 위조 내부 Header 무시': () => auth024Pass })
    record(env, {
      testCaseId: 'AUTH-024',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: auth024Pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId,
      assertions: { normalLoginDespiteForgedHeaders: auth024Pass },
      errorClass: auth024Pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('AUTH-003: RequestId 없이 로그인 → 서버가 생성', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const jar = freshJar()

    const res = postJson(loginUrl, {
      tenantCode: account.tenantCode,
      loginId: account.loginId,
      password: account.password,
    }, { jar })

    const requestId = header(res, 'X-Request-Id') || ''
    const generated = res.status === 200 && requestId.length >= 1 && requestId.length <= 64
    check(null, { 'AUTH-003 서버 생성 RequestId': () => generated })
    record(env, {
      testCaseId: 'AUTH-003',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: generated ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId,
      assertions: { status200: res.status === 200, requestIdGenerated: generated },
      errorClass: generated ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('AUTH-004: tenantCode 공백·대문자 정규화', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const jar = freshJar()

    const res = postJson(
      loginUrl,
      { tenantCode: `  ${account.tenantCode.toUpperCase()}  `, loginId: account.loginId, password: account.password },
      { jar },
    )

    const pass = res.status === 200
    check(null, { 'AUTH-004 정규화 후 로그인 성공': () => pass })
    record(env, {
      testCaseId: 'AUTH-004',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { normalizedTenantAccepted: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('AUTH-010: 정상 계정 + 잘못된 비밀번호 1회', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const jar = freshJar()

    const res = postJson(
      loginUrl,
      { tenantCode: account.tenantCode, loginId: account.loginId, password: `${account.password}-wrong` },
      { jar },
    )

    const body = parseProblem(res)
    const noSessionCookie = !res.cookies || !res.cookies.SESSION
    const pass = res.status === 401 && body.code === 'AUTHENTICATION_FAILED' && noSessionCookie
    check(null, { 'AUTH-010 401 AUTHENTICATION_FAILED': () => pass })
    record(env, {
      testCaseId: 'AUTH-010',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 401 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status401: res.status === 401, codeMatches: body.code === 'AUTHENTICATION_FAILED', noSessionCookie },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('AUTH-020: 필수 Field 누락', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = postJson(loginUrl, { tenantCode: DUMMY_TENANT, loginId: DUMMY_LOGIN_ID }, { jar: freshJar() })
    const body = parseProblem(res)
    const pass =
      res.status === 400 && body.code === 'VALIDATION_FAILED' && Array.isArray(body.fieldErrors) && body.fieldErrors.length > 0
    check(null, { 'AUTH-020 400 VALIDATION_FAILED + fieldErrors': () => pass })
    record(env, {
      testCaseId: 'AUTH-020',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 400 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status400: res.status === 400, codeMatches: body.code === 'VALIDATION_FAILED', fieldErrorsPresent: Array.isArray(body.fieldErrors) && body.fieldErrors.length > 0 },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('AUTH-021: 최대 길이 초과 입력', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const overlong = 'x'.repeat(5000)
    const res = postJson(loginUrl, { tenantCode: DUMMY_TENANT, loginId: overlong, password: overlong }, { jar: freshJar() })
    const body = parseProblem(res)
    const noInternalLeak = !/Exception|SQL|java\.|Caused by/i.test(String(res.body || ''))
    const applicationRejected = res.status === 400 && body.code === 'VALIDATION_FAILED'
    const wafRejected = res.status === 403
    const rejectionLayer = applicationRejected ? 'APPLICATION_VALIDATION' : wafRejected ? 'CLOUDFRONT_WAF' : 'UNKNOWN'

    // 실측 결과(운영, 2026-08-27): loginId/password 각 5,000자의 JSON Body는 CloudFront WAF의
    // AWSManagedRulesCommonRuleSet/SizeRestrictions_BODY가 애플리케이션보다 먼저 403으로 차단한다.
    // 현재 LoginRequest에는 @NotBlank만 있고 최대 길이 Validation은 없으므로 400만 강제할 근거도 없다.
    // AUTH-031과 같은 원칙으로, 애플리케이션의 400 또는 WAF의 403이면서 내부 정보를 노출하지 않으면
    // 과대 입력을 안전하게 거절했다는 이 케이스의 보안 목적을 충족한 것으로 판정한다.
    const pass = (applicationRejected || wafRejected) && noInternalLeak
    check(null, { 'AUTH-021 과대 입력 안전한 거절(애플리케이션 400 또는 WAF 403)': () => pass })
    record(env, {
      testCaseId: 'AUTH-021',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { acceptedHttpStatuses: [400, 403], applicationCodeWhen400: 'VALIDATION_FAILED', noInternalLeak: true },
      observed: { httpStatus: res.status, rejectionLayer },
      requestId: header(res, 'X-Request-Id'),
      assertions: { applicationRejected, wafRejected, noInternalLeak },
      errorClass: applicationRejected
        ? 'APPLICATION_VALIDATION_REJECTION'
        : wafRejected
          ? 'WAF_SIZE_RESTRICTION_REJECTION'
          : 'ASSERTION_MISMATCH',
    })
  })

  group('AUTH-022: 깨진 JSON', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = postRaw(loginUrl, '{"tenantCode": "broken", "loginId":', { jar: freshJar() })
    const body = parseProblem(res)
    const isProblemJson = (header(res, 'Content-Type') || '').startsWith('application/problem+json')
    const pass = res.status === 400 && body.code === 'VALIDATION_FAILED' && isProblemJson
    check(null, { 'AUTH-022 깨진 JSON → 400': () => pass })
    record(env, {
      testCaseId: 'AUTH-022',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 400 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status400: res.status === 400, codeMatches: body.code === 'VALIDATION_FAILED', isProblemJson },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('AUTH-023: POST 외 Method → Fail-Closed 503', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = getJson(loginUrl, { jar: freshJar() })
    const pass = res.status === 503
    check(null, { 'AUTH-023 GET → 503 Fail-Closed': () => pass })
    record(env, {
      testCaseId: 'AUTH-023',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 503 },
      observed: { httpStatus: res.status, requestMethod: 'GET' },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status503: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })
}

// handleSummary()는 일부러 두지 않는다 — VU 실행과 별도의 격리된 JS VM에서 돌기 때문에 위
// record()가 쌓은 결과를 여기서 볼 수 없다(resultLogger.js 주석 참고). summary.json/junit.xml은
// `--log-format=raw`로 찍힌 stdout을 api/lib/build-report.mjs로 후처리해서 만든다(README 참고).
