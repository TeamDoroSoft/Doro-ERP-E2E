import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, patchJson, getJson, header, parseProblem, xsrfTokenFrom } from '../lib/http.js'
import { record } from '../lib/resultLogger.js'
import { provisioningAvailable, provisionThrowawayOwner, randomToken, randomPassword } from '../lib/provisioning.js'

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

// 실행 뒤 `node api/lib/build-report.mjs <log> session-flow SESS-001,SESS-002,SESS-003`로 summary.json을
// 만든다 — 이 스크립트가 다루는 필수 케이스 ID (README 참고). SESS-004/005는 Provisioning
// 자격증명이 있을 때만 추가되므로 그때는 뒤에 이어 붙인다(README 참고).

// FE-BE-003이 실제 화면에서 로그인 직후 자동으로 호출하는 것과 같은 비파괴 조회 API를
// 그대로 쓴다 (Role 제한 없음 — EdgeOrderController.java, OrderController.java 확인 완료).
const PROTECTED_PATH = '/api/v1/orders'

export default function () {
  const env = loadDeployEnv()
  const loginUrl = `${env.apiOrigin}/api/v1/auth/login`
  const protectedUrl = `${env.apiOrigin}${PROTECTED_PATH}`
  const account = env.authValid01

  // 이 스크립트 하나로 AUTH_VALID_01 실계정 로그인을 1회만 소비한다(§2.5 Rate Limit Bucket).
  // auth-mandatory.js와 60초 이내에 연달아 돌리지 말 것 — README 참고.
  const jar = freshJar()
  const loginRes = postJson(
    loginUrl,
    { tenantCode: account.tenantCode, loginId: account.loginId, password: account.password },
    { jar },
  )
  if (loginRes.status !== 200) {
    const startedAt = new Date().toISOString()
    for (const id of ['SESS-001', 'SESS-002']) {
      record(env, {
        testCaseId: id,
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_VALID_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: `사전 로그인 실패 (status=${loginRes.status}) — SESS-* 전제조건 불충족`,
      })
    }
    return
  }

  group('SESS-001: 로그인 Cookie로 비파괴 조회 API 호출', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = getJson(protectedUrl, { jar })
    const pass = res.status === 200
    check(null, { 'SESS-001 보호 API 200': () => pass })
    record(env, {
      testCaseId: 'SESS-001',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_PROTECTED_FLOW',
      expected: { requestPath: PROTECTED_PATH, protectedApiStatus: 200 },
      observed: { protectedApiPath: PROTECTED_PATH, protectedApiStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status200: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('SESS-002: SESSION 없이 같은 API 호출', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = getJson(protectedUrl, { jar: freshJar() }) // 빈 Jar — Cookie 전혀 없음
    const body = parseProblem(res)
    const pass = res.status === 401
    check(null, { 'SESS-002 401': () => pass })
    record(env, {
      testCaseId: 'SESS-002',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: PROTECTED_PATH, httpStatus: 401 },
      observed: { protectedApiPath: PROTECTED_PATH, protectedApiStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status401: pass, code: body.code || null },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('SESS-003: 변조된 SESSION으로 같은 API 호출', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()

    // SESS-001에서 로그인 성공한 jar를 그대로 재사용하되 SESSION 값만 깨뜨린다 — XSRF-TOKEN 등
    // 나머지 Cookie는 그대로 둬서 "SESSION만 변조된" 상황을 정확히 재현한다. 형식 자체가 깨진 값을
    // 써서 Redis 조회 실패 경로와 Parser 실패 경로 둘 다 건드릴 가능성을 높인다(보고서 §5.6:
    // "Redis·Parser 상세 비노출" — 둘 중 하나만 확인하면 다른 경로의 누출을 놓칠 수 있다).
    const cookies = jar.cookiesForURL(protectedUrl)
    const realSession = cookies['SESSION'] && cookies['SESSION'][0]
    const tamperedSession = `${realSession ? realSession.slice(0, -4) : ''}%%%%garbage-not-base64%%%%`
    jar.set(protectedUrl, 'SESSION', tamperedSession)

    const res = getJson(protectedUrl, { jar })
    const body = parseProblem(res)
    const bodyText = JSON.stringify(body).toLowerCase()
    // 내부 구현 상세(Redis 키 이름, 예외 클래스, 스택트레이스 등)가 새면 안 된다 — SESS-002와
    // 같은 401 Shape(제네릭 UNAUTHENTICATED 계열)인지, 그리고 아래 금칙어가 없는지 확인한다.
    const leakedKeywords = ['redis', 'deserializ', 'exception', 'stacktrace', 'nullpointer', 'com.dorosoft', 'at java.', 'at org.springframework']
    const noInternalLeak = !leakedKeywords.some((kw) => bodyText.includes(kw))
    const pass = res.status === 401 && noInternalLeak
    check(null, { 'SESS-003 401 & 내부 상세 비노출': () => pass })
    record(env, {
      testCaseId: 'SESS-003',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: PROTECTED_PATH, httpStatus: 401 },
      observed: { protectedApiPath: PROTECTED_PATH, protectedApiStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status401: res.status === 401, noInternalLeak, code: body.code || null },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('SESS-004 / SESS-005: 임시 비밀번호 로그인과 비밀번호 변경 후 기존 Session 거절', () => {
    const startedAt = new Date().toISOString()

    if (!provisioningAvailable(env)) {
      for (const id of ['SESS-004', 'SESS-005']) {
        record(env, {
          testCaseId: id,
          startedAt,
          durationMs: 0,
          resultCode: 'SKIP_PRECONDITION',
          errorClass: 'PROVISIONING_ORIGIN/STORE_ACCESS_PROVISIONING_USERNAME/PASSWORD 미설정 — 1회용 Fixture 생성 불가',
        })
      }
      return
    }

    // AUTH_VALID_01(§2.5 Bucket)이 아니라 이 케이스 전용 1회용 테넌트+OWNER를 새로 만든다.
    const fixture = {
      tenantCode: `e2e-sess-${randomToken().slice(0, 12)}`,
      tenantName: 'Doro E2E SESS Fixture',
      storeName: 'Doro E2E SESS Fixture Store',
      loginId: 'owner',
      temporaryPassword: randomPassword('Sess004Temp'),
    }
    const permanentPassword = randomPassword('Sess005Perm')

    try {
      provisionThrowawayOwner(env, fixture)
    } catch (error) {
      for (const id of ['SESS-004', 'SESS-005']) {
        record(env, {
          testCaseId: id,
          startedAt,
          durationMs: 0,
          resultCode: 'ERROR_TRANSPORT',
          errorClass: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    const t004 = Date.now()
    const jar = freshJar()
    const loginRes = postJson(
      loginUrl,
      { tenantCode: fixture.tenantCode, loginId: fixture.loginId, password: fixture.temporaryPassword },
      { jar },
    )
    const loginBody = parseProblem(loginRes)
    const pass004 = loginRes.status === 200 && loginBody.passwordChangeRequired === true
    check(null, { 'SESS-004 임시 비밀번호 로그인': () => pass004 })
    record(env, {
      testCaseId: 'SESS-004',
      startedAt,
      durationMs: Date.now() - t004,
      resultCode: pass004 ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: '/api/v1/auth/login', httpStatus: 200 },
      observed: { httpStatus: loginRes.status },
      requestId: header(loginRes, 'X-Request-Id'),
      assertions: { status200: loginRes.status === 200, passwordChangeRequired: loginBody.passwordChangeRequired === true },
      errorClass: pass004 ? null : 'ASSERTION_MISMATCH',
    })

    if (!pass004) {
      record(env, {
        testCaseId: 'SESS-005',
        startedAt,
        durationMs: 0,
        resultCode: 'SKIP_PRECONDITION',
        errorClass: 'SESS-004 실패로 전제조건(임시 비밀번호 Session) 불충족',
      })
      return
    }

    const changeRes = patchJson(
      `${env.apiOrigin}/api/v1/employees/me/password`,
      { currentPassword: fixture.temporaryPassword, newPassword: permanentPassword },
      { jar, headers: { 'X-XSRF-TOKEN': xsrfTokenFrom(jar, protectedUrl) } },
    )
    if (changeRes.status !== 200) {
      record(env, {
        testCaseId: 'SESS-005',
        startedAt,
        durationMs: 0,
        resultCode: 'ERROR_TRANSPORT',
        errorClass: `비밀번호 변경 실패: HTTP ${changeRes.status}`,
      })
      return
    }

    const t005 = Date.now()
    // 방금 비밀번호를 바꾼 계정의 "옛 Session"(jar)을 그대로 재사용 — Store Access가 비밀번호
    // 변경 시 기존 Session을 전부 무효화해야 하므로 401이 나와야 정상이다.
    const oldSessionRes = getJson(protectedUrl, { jar })
    const pass005 = oldSessionRes.status === 401
    check(null, { 'SESS-005 비밀번호 변경 후 기존 Session 거절': () => pass005 })
    record(env, {
      testCaseId: 'SESS-005',
      startedAt,
      durationMs: Date.now() - t005,
      resultCode: pass005 ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: PROTECTED_PATH, httpStatus: 401 },
      observed: { protectedApiPath: PROTECTED_PATH, protectedApiStatus: oldSessionRes.status },
      requestId: header(oldSessionRes, 'X-Request-Id'),
      assertions: { oldSessionRejected: pass005 },
      errorClass: pass005 ? null : 'ASSERTION_MISMATCH',
    })
  })
}

// handleSummary()는 일부러 두지 않는다 — VU 실행과 별도의 격리된 JS VM에서 돌기 때문에 위
// record()가 쌓은 결과를 여기서 볼 수 없다. summary.json/junit.xml은 `--log-format=raw`로 찍힌
// stdout을 api/lib/build-report.mjs로 후처리해서 만든다(README 참고).
