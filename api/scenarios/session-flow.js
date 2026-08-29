import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, patchJson, getJson, header, parseProblem, xsrfTokenFrom } from '../lib/http.js'
import { record } from '../lib/resultLogger.js'

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

// 실행 뒤 `node api/lib/build-report.mjs <log> session-flow SESS-001,SESS-002,SESS-003,SESS-006,SESS-007`로
// summary.json을 만든다 — 이 스크립트가 다루는 필수 케이스 ID (README 참고). SESS-004/005는
// 전용 정적 계정(AUTH_TEMP_PASSWORD_01/AUTH_PASSWORD_ROTATE_01)이 있을 때만 추가되므로 그때는
// 뒤에 이어 붙인다(README 참고) — 실 배포 대상 테넌트 DB에 Provisioning API로 계정을 만들지 않는다.
//
// SESS-006/007: /api/v1/auth/reauthenticate(ADR-02-003/011, "중요 관리 작업 전 15분 재인증 창"
// 갱신). 원래 SESS-* 카탈로그엔 없던 항목 — Doro-ERP-Service의 최근 tests/system 커밋을 검토하다
// 이 Endpoint가 Edge HMAC 보호 대상이 됐다는 걸 알게 됐고, 실제로 보니 실패 카운트가 로그인
// 잠금(AUTH-030류)과 별개로 Session에만 종속된 걸 확인해서 추가했다.

// FE-BE-003이 실제 화면에서 로그인 직후 자동으로 호출하는 것과 같은 비파괴 조회 API를
// 그대로 쓴다 (Role 제한 없음 — EdgeOrderController.java, OrderController.java 확인 완료).
const PROTECTED_PATH = '/api/v1/orders'

export default function () {
  const env = loadDeployEnv()
  const loginUrl = `${env.apiOrigin}/api/v1/auth/login`
  const protectedUrl = `${env.apiOrigin}${PROTECTED_PATH}`
  const account = env.authValid01

  // 이 스크립트는 AUTH_VALID_01 실계정 로그인을 총 3회 소비한다(Rate Limit Bucket) — 이 최초
  // 로그인 1회 + 아래 SESS-007 안의 사전 로그인·재로그인 2회(Session 무효화와 계정 잠금을
  // 구분하려면 별도 Session에서 다시 로그인해야 해서 줄일 수 없다). auth-mandatory.js와
  // 충분한 간격 없이 연달아 돌리지 말 것 — README 참고.
  const jar = freshJar()
  const loginRes = postJson(
    loginUrl,
    { tenantCode: account.tenantCode, loginId: account.loginId, password: account.password },
    { jar },
  )
  if (loginRes.status !== 200) {
    const startedAt = new Date().toISOString()
    for (const id of ['SESS-001', 'SESS-002', 'SESS-006']) {
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

  group('SESS-006: 재인증 성공 시 Session ID 회전', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const reauthUrl = `${env.apiOrigin}/api/v1/auth/reauthenticate`

    const sessionBefore = (jar.cookiesForURL(protectedUrl)['SESSION'] || [])[0]
    const res = postJson(
      reauthUrl,
      { password: account.password },
      { jar, headers: { 'X-XSRF-TOKEN': xsrfTokenFrom(jar, protectedUrl) } },
    )
    // ReauthenticationService.recordSuccessAndRotate가 성공 즉시 새 SESSION Cookie를 발급한다 —
    // k6 CookieJar가 응답의 Set-Cookie를 자동 반영하므로 이후 jar를 계속 써도 된다.
    const sessionAfter = (jar.cookiesForURL(protectedUrl)['SESSION'] || [])[0]
    const rotated = !!sessionBefore && !!sessionAfter && sessionBefore !== sessionAfter
    const pass = res.status === 204 && rotated
    check(null, { 'SESS-006 재인증 성공 & Session 회전': () => pass })
    record(env, {
      testCaseId: 'SESS-006',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: '/api/v1/auth/reauthenticate', httpStatus: 204 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status204: res.status === 204, sessionRotated: rotated },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('SESS-007: 재인증 실패 누적 — 계정이 아니라 Session만 무효화', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()

    // SESS-006과 별개의 새 Session에서 진행한다 — 실패 횟수가 Session에 종속되므로(위 주석
    // 참고), 회전 뒤 Session과 섞이면 몇 번째 시도인지 계산이 꼬인다.
    const reauthJar = freshJar()
    const preLoginRes = postJson(
      loginUrl,
      { tenantCode: account.tenantCode, loginId: account.loginId, password: account.password },
      { jar: reauthJar },
    )
    if (preLoginRes.status !== 200) {
      record(env, {
        testCaseId: 'SESS-007',
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_VALID_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: `SESS-007 전용 로그인 실패 (status=${preLoginRes.status}) — 전제조건 불충족`,
      })
      return
    }

    const reauthUrl = `${env.apiOrigin}/api/v1/auth/reauthenticate`
    const statuses = []
    let lastRes
    for (let i = 0; i < 5; i++) {
      lastRes = postJson(
        reauthUrl,
        { password: `wrong-${i}` },
        { jar: reauthJar, headers: { 'X-XSRF-TOKEN': xsrfTokenFrom(reauthJar, protectedUrl) } },
      )
      statuses.push(lastRes.status)
    }
    const lastBody = parseProblem(lastRes)

    // ReauthenticationService.MAX_CONSECUTIVE_FAILURES=5: 1~4회차는 AUTHENTICATION_FAILED,
    // 5회차에 SESSION_INVALIDATED로 바뀐다. 둘 다 HTTP Status는 401이라 code로 구분해야 한다.
    const first4All401 = statuses.slice(0, 4).every((s) => s === 401)
    const fifthInvalidated = lastRes.status === 401 && lastBody.code === 'SESSION_INVALIDATED'

    // 무효화된 Session으로 보호 API를 호출해도 401이어야 한다.
    const afterRes = getJson(protectedUrl, { jar: reauthJar })
    const sessionRejectedAfter = afterRes.status === 401

    // 이건 계정 잠금이 아니라 Session 무효화라, 같은 계정으로 다시 로그인하면 정상 성공해야
    // 한다 — AUTH-030류(계정 잠금)와 구분되는 지점이다.
    const reloginRes = postJson(
      loginUrl,
      { tenantCode: account.tenantCode, loginId: account.loginId, password: account.password },
      { jar: freshJar() },
    )
    const accountNotLocked = reloginRes.status === 200

    const pass = first4All401 && fifthInvalidated && sessionRejectedAfter && accountNotLocked
    check(null, { 'SESS-007 재인증 실패 누적 시 Session만 무효화': () => pass })
    record(env, {
      testCaseId: 'SESS-007',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: '/api/v1/auth/reauthenticate', httpStatus: 401 },
      observed: { httpStatus: lastRes.status, code: lastBody.code || null },
      requestId: header(lastRes, 'X-Request-Id'),
      assertions: {
        first4Failures401: first4All401,
        fifthSessionInvalidated: fifthInvalidated,
        sessionRejectedAfterInvalidation: sessionRejectedAfter,
        accountNotLocked,
      },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('SESS-003: 변조된 SESSION으로 같은 API 호출', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()

    // SESS-001에서 로그인 성공한 jar를 그대로 재사용하되 SESSION 값만 깨뜨린다 — XSRF-TOKEN 등
    // 나머지 Cookie는 그대로 둬서 "SESSION만 변조된" 상황을 정확히 재현한다. 형식 자체가 깨진 값을
    // 써서 Redis 조회 실패 경로와 Parser 실패 경로 둘 다 건드릴 가능성을 높인다("Redis·Parser
    // 상세 비노출" — 둘 중 하나만 확인하면 다른 경로의 누출을 놓칠 수 있다).
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

  // SESS-004/005는 각자 다른 정적 계정을 쓰는 독립된 시나리오다 — 실 배포 대상 테넌트 DB에
  // Provisioning API로 계정을 만들지 않는다(Docs/Specifications/운영·배포/
  // "배포 검증용 테스트 계정 요청.md" 참고).

  group('SESS-004: 임시 비밀번호 로그인', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const tempAccount = env.staticAccounts.tempPassword
    if (!tempAccount) {
      record(env, {
        testCaseId: 'SESS-004',
        startedAt,
        durationMs: 0,
        resultCode: 'SKIP_PRECONDITION',
        errorClass: 'AUTH_TEMP_PASSWORD_01 정적 계정 없음 — 임시 비밀번호 Fixture 준비 불가',
      })
      return
    }

    const loginRes = postJson(
      loginUrl,
      { tenantCode: tempAccount.tenantCode, loginId: tempAccount.loginId, password: tempAccount.password },
      { jar: freshJar() },
    )
    const loginBody = parseProblem(loginRes)
    const pass = loginRes.status === 200 && loginBody.passwordChangeRequired === true
    check(null, { 'SESS-004 임시 비밀번호 로그인': () => pass })
    record(env, {
      testCaseId: 'SESS-004',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: '/api/v1/auth/login', httpStatus: 200 },
      observed: { httpStatus: loginRes.status },
      requestId: header(loginRes, 'X-Request-Id'),
      assertions: { status200: loginRes.status === 200, passwordChangeRequired: loginBody.passwordChangeRequired === true },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('SESS-005: 비밀번호 변경 후 기존 Session 거절', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const rotateAccount = env.staticAccounts.passwordRotate
    if (!rotateAccount) {
      record(env, {
        testCaseId: 'SESS-005',
        startedAt,
        durationMs: 0,
        resultCode: 'SKIP_PRECONDITION',
        errorClass: 'AUTH_PASSWORD_ROTATE_01 정적 계정 없음 — 비밀번호 변경 Fixture 준비 불가',
      })
      return
    }

    // 이 계정은 매 실행마다 실제로 비밀번호를 바꾸므로 "지금 현재 비밀번호가 A인지 B인지"를
    // 스스로 판별해야 한다 — A로 먼저 로그인 시도, 실패하면 B로 시도한다
    // (scripts/local-rehearsal/provision-local-rehearsal-account.mjs가 쓰는 "먼저 시도해서 현재 상태를 알아내는"
    // 패턴과 동일). 성공한 쪽이 현재 비밀번호이고, 반대쪽으로 바꾼다.
    const jar = freshJar()
    let currentPassword = rotateAccount.passwordA
    let newPassword = rotateAccount.passwordB
    let loginRes = postJson(
      loginUrl,
      { tenantCode: rotateAccount.tenantCode, loginId: rotateAccount.loginId, password: currentPassword },
      { jar },
    )
    if (loginRes.status !== 200) {
      currentPassword = rotateAccount.passwordB
      newPassword = rotateAccount.passwordA
      loginRes = postJson(
        loginUrl,
        { tenantCode: rotateAccount.tenantCode, loginId: rotateAccount.loginId, password: currentPassword },
        { jar },
      )
    }
    if (loginRes.status !== 200) {
      record(env, {
        testCaseId: 'SESS-005',
        startedAt,
        durationMs: Date.now() - t0,
        resultCode: 'ERROR_TRANSPORT',
        errorClass: `A/B 비밀번호 둘 다 로그인 실패 (status=${loginRes.status}) — AUTH_PASSWORD_ROTATE_01 계정 상태를 직접 확인 필요`,
      })
      return
    }

    const changeRes = patchJson(
      `${env.apiOrigin}/api/v1/employees/me/password`,
      { currentPassword, newPassword },
      { jar, headers: { 'X-XSRF-TOKEN': xsrfTokenFrom(jar, protectedUrl) } },
    )
    if (changeRes.status !== 200) {
      record(env, {
        testCaseId: 'SESS-005',
        startedAt,
        durationMs: Date.now() - t0,
        resultCode: 'ERROR_TRANSPORT',
        errorClass: `비밀번호 변경 실패: HTTP ${changeRes.status}`,
      })
      return
    }

    // 방금 비밀번호를 바꾼 계정의 "옛 Session"(jar)을 그대로 재사용 — Store Access가 비밀번호
    // 변경 시 기존 Session을 전부 무효화해야 하므로 401이 나와야 정상이다.
    const oldSessionRes = getJson(protectedUrl, { jar })
    const pass = oldSessionRes.status === 401
    check(null, { 'SESS-005 비밀번호 변경 후 기존 Session 거절': () => pass })
    record(env, {
      testCaseId: 'SESS-005',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: PROTECTED_PATH, httpStatus: 401 },
      observed: { protectedApiPath: PROTECTED_PATH, protectedApiStatus: oldSessionRes.status },
      requestId: header(oldSessionRes, 'X-Request-Id'),
      assertions: { oldSessionRejected: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })
}

// handleSummary()는 일부러 두지 않는다 — VU 실행과 별도의 격리된 JS VM에서 돌기 때문에 위
// record()가 쌓은 결과를 여기서 볼 수 없다. summary.json/junit.xml은 `--log-format=raw`로 찍힌
// stdout을 api/lib/build-report.mjs로 후처리해서 만든다(README 참고).
