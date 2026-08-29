import { test, expect, type ConsoleMessage, type Page, type Request, type Response } from '@playwright/test'
import { loadDeployEnv } from '../lib/env'
import { loginAsAuthValid01 } from '../lib/loginFlow'
import { appendCaseResult, type CaseResultInput } from '../lib/resultLogger'

// FE-BE-001~006: 배포 Frontend–Backend 종단 검증.md §3 "필수 Browser Gate". Mock, page.route().fulfill(),
// Session Storage 사전 주입을 쓰지 않는다 — 실제 배포 Origin을 그대로 연다.

const env = loadDeployEnv()

function currentRunId(): string {
  const runId = process.env.DORO_RUN_ID
  if (!runId) throw new Error('DORO_RUN_ID가 없습니다 — global-setup이 실행되지 않은 채로 테스트가 시작됐습니다')
  return runId
}

interface BrowserErrors {
  consoleErrors: string[]
  pageErrors: string[]
  failedRequests: string[]
}

function trackBrowserErrors(page: Page): BrowserErrors {
  const errors: BrowserErrors = { consoleErrors: [], pageErrors: [], failedRequests: [] }
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err: Error) => errors.pageErrors.push(err.message))
  page.on('requestfailed', (req: Request) => {
    errors.failedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`)
  })
  return errors
}

function browserCounts(errors: BrowserErrors) {
  return {
    consoleErrorCount: errors.consoleErrors.length,
    pageErrorCount: errors.pageErrors.length,
    failedRequiredRequestCount: errors.failedRequests.length,
  }
}

function sanitizedConsoleErrors(messages: string[]): string[] {
  return messages.slice(0, 5).map((message) =>
    message
      .replace(/(?:https?|wss?):\/\/\S+/gi, '[URL]')
      .replace(/\b(bearer|token|password|cookie|csrf|session|authorization)\b\s*[:=]?\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]')
      .slice(0, 500),
  )
}

function record(input: CaseResultInput) {
  appendCaseResult(currentRunId(), env, input)
}

test('FE-BE-001 배포 로그인 화면 로드', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  const response = await page.goto('/pos/login')
  const status = response?.status() ?? 0
  const formVisible = await page
    .locator('input[name="tenantCode"]')
    .isVisible()
    .catch(() => false)

  const pass =
    status >= 200 &&
    status < 300 &&
    formVisible &&
    errors.consoleErrors.length === 0 &&
    errors.pageErrors.length === 0 &&
    errors.failedRequests.length === 0

  record({
    testCaseId: 'FE-BE-001',
    startedAt,
    durationMs: Date.now() - t0,
    resultCode: pass ? 'PASS' : 'FAIL_UI',
    expected: { startPath: '/pos/login', httpStatus: 200 },
    observed: { startPath: '/pos/login', httpStatus: status },
    assertions: {
      documentLoaded: status >= 200 && status < 300,
      loginFormVisible: formVisible,
      consoleErrorsAbsent: errors.consoleErrors.length === 0,
      pageErrorsAbsent: errors.pageErrors.length === 0,
      failedRequestsAbsent: errors.failedRequests.length === 0,
    },
    browser: browserCounts(errors),
    errorClass: pass ? null : 'UI_PAGE_LOAD_FAILED',
  })

  expect(
    pass,
    `FE-BE-001 실패: status=${status} formVisible=${formVisible} console=${errors.consoleErrors.length} pageErr=${errors.pageErrors.length} failedReq=${errors.failedRequests.length}`,
  ).toBe(true)
})

test('FE-BE-002 정상 계정으로 화면 로그인', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const account = env.authValid01

  await page.goto('/pos/login')
  await page.locator('input[name="tenantCode"]').fill(account.tenantCode)
  await page.locator('input[name="loginId"]').fill(account.loginId)
  await page.locator('input[name="password"]').fill(account.password)

  let loginResponse: Response | null = null
  let transportError: string | null = null
  try {
    ;[loginResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/login',
      ),
      page.locator('button.submit-button').click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const requestUrl = loginResponse ? new URL(loginResponse.url()) : null
  const targetApproved =
    requestUrl !== null && requestUrl.origin === env.frontendOrigin && requestUrl.pathname === '/api/v1/auth/login'
  const status = loginResponse?.status() ?? 0
  const requestId = loginResponse?.headers()['x-request-id'] ?? ''

  let finalPath = ''
  let redirected = false
  if (targetApproved && status === 200) {
    try {
      await page.waitForURL('**/pos/orders', { timeout: 10_000 })
      finalPath = new URL(page.url()).pathname
      redirected = finalPath === '/pos/orders'
    } catch {
      finalPath = new URL(page.url()).pathname
    }
  }

  const pass = targetApproved && status === 200 && redirected && requestId !== ''
  const resultCode = transportError
    ? 'ERROR_TRANSPORT'
    : !targetApproved
      ? 'FAIL_NETWORK_MAPPING'
      : pass
        ? 'PASS'
        : 'FAIL_UI'
  const errorClass = pass
    ? null
    : transportError
      ? 'UI_API_REQUEST_NOT_SENT'
      : !targetApproved
        ? 'UI_API_TARGET_MISMATCH'
        : status !== 200
          ? 'UI_RESPONSE_MAPPING_FAILED'
          : !redirected
            ? 'UI_REDIRECT_MISMATCH'
            : 'UI_RESPONSE_MAPPING_FAILED'

  record({
    testCaseId: 'FE-BE-002',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode,
    expected: { startPath: '/pos/login', requestPath: '/api/v1/auth/login', httpStatus: 200, finalPath: '/pos/orders' },
    observed: {
      startPath: '/pos/login',
      requestMethod: loginResponse?.request().method(),
      requestPath: requestUrl?.pathname,
      httpStatus: status,
      finalPath,
    },
    requestId,
    assertions: { apiTargetApproved: targetApproved, status: status === 200, redirect: redirected, requestIdPresent: requestId !== '' },
    browser: browserCounts(errors),
    errorClass,
  })

  expect(
    pass,
    `FE-BE-002 실패: targetApproved=${targetApproved} status=${status} redirected=${redirected} requestId="${requestId}" transportError=${transportError}`,
  ).toBe(true)
})

test('FE-BE-003 로그인 후 보호 화면 사용', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const account = env.authValid01

  await page.goto('/pos/login')
  await page.locator('input[name="tenantCode"]').fill(account.tenantCode)
  await page.locator('input[name="loginId"]').fill(account.loginId)
  await page.locator('input[name="password"]').fill(account.password)

  let loginResponse: Response | null = null
  let ordersResponse: Response | null = null
  let ordersRequestSent = false
  page.on('request', (request: Request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/orders') {
      ordersRequestSent = true
    }
  })

  // 로그인 성공 직후 PosOrdersView가 onMounted에서 자동으로 쏘는 GET /api/v1/orders를
  // 놓치지 않으려면, 클릭 전에 두 대기를 모두 등록한다. Promise.all()을 쓰면 주문 응답
  // timeout 하나가 로그인 응답까지 버려져 원인을 "요청 미발생"으로 잘못 기록하므로, 각 결과를
  // 독립적으로 보존한다.
  const [loginResult, ordersResult, clickResult] = await Promise.allSettled([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/login',
    ),
    page.waitForResponse(
      (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/v1/orders',
    ),
    page.locator('button.submit-button').click(),
  ])
  if (loginResult.status === 'fulfilled') loginResponse = loginResult.value
  if (ordersResult.status === 'fulfilled') ordersResponse = ordersResult.value

  const loginOk = loginResponse?.status() === 200
  const ordersStatus = ordersResponse?.status() ?? 0
  const ordersOk = ordersStatus === 200
  const screenOk = ordersOk
    ? await page
        .locator('main.orders-page')
        .isVisible()
        .catch(() => false)
    : false

  const pass = loginOk && ordersOk && screenOk
  const hasTransportError =
    loginResult.status === 'rejected' || ordersResult.status === 'rejected' || clickResult.status === 'rejected'
  const errorClass = pass
    ? null
    : loginResult.status === 'rejected'
      ? 'UI_LOGIN_RESPONSE_NOT_RECEIVED'
      : !loginOk
        ? 'AUTH_LOGIN_FAILED'
        : clickResult.status === 'rejected' || !ordersRequestSent
          ? 'UI_API_REQUEST_NOT_SENT'
          : ordersResult.status === 'rejected'
            ? 'UI_API_RESPONSE_NOT_RECEIVED'
            : 'UI_PROTECTED_API_FAILED'
  const resultCode = hasTransportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_PROTECTED_FLOW'

  record({
    testCaseId: 'FE-BE-003',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode,
    expected: { requestPath: '/api/v1/orders', protectedApiStatus: 200 },
    observed: {
      loginStatus: loginResponse?.status() ?? 0,
      protectedApiPath: ordersResponse ? new URL(ordersResponse.url()).pathname : undefined,
      protectedApiStatus: ordersStatus,
      protectedApiRequestSent: ordersRequestSent,
    },
    requestId: ordersResponse?.headers()['x-request-id'] ?? '',
    assertions: {
      loginSucceeded: !!loginOk,
      protectedApiRequestSent: ordersRequestSent,
      protectedApiSucceeded: ordersOk,
      protectedScreenVisible: screenOk,
    },
    browser: browserCounts(errors),
    errorClass,
  })

  expect(
    pass,
    `FE-BE-003 실패: loginOk=${loginOk} ordersRequestSent=${ordersRequestSent} ordersStatus=${ordersStatus} ` +
      `screenOk=${screenOk} errorClass=${errorClass}`,
  ).toBe(true)
})

test('FE-BE-004 로그인 후 같은 Tab 새로고침', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  await loginAsAuthValid01(page, env)

  let reloadOrdersResponse: Response | null = null
  let transportError: string | null = null
  try {
    ;[reloadOrdersResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/v1/orders',
      ),
      page.reload(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const status = reloadOrdersResponse?.status() ?? 0
  const stillOnOrders = new URL(page.url()).pathname === '/pos/orders'
  const pass = status === 200 && stillOnOrders
  const resultCode = transportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_PROTECTED_FLOW'

  record({
    testCaseId: 'FE-BE-004',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode,
    expected: { requestPath: '/api/v1/orders', protectedApiStatus: 200, finalPath: '/pos/orders' },
    observed: { protectedApiStatus: status, finalPath: new URL(page.url()).pathname },
    requestId: reloadOrdersResponse?.headers()['x-request-id'] ?? '',
    assertions: { protectedApiSucceededAfterReload: status === 200, sessionRetained: stillOnOrders },
    browser: browserCounts(errors),
    errorClass: pass ? null : transportError ? 'UI_API_REQUEST_NOT_SENT' : 'UI_SESSION_NOT_PERSISTED',
  })

  expect(pass, `FE-BE-004 실패: status=${status} stillOnOrders=${stillOnOrders} transportError=${transportError}`).toBe(true)
})

test('FE-BE-005 잘못된 비밀번호 1회', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  // AUTH_VALID_01은 FE-BE-002~004/006의 정상 로그인에 연속으로 쓰인다. 잘못된 비밀번호
  // 요청까지 같은 (tenantCode, loginId) 버킷에 넣으면 정상 배포도 429로 오판할 수 있으므로,
  // 별도 MANAGER 계정으로 실패 응답만 검증한다.
  const account = env.staticAccounts.roleManager
  if (!account) {
    record({
      testCaseId: 'FE-BE-005',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass: 'AUTH_ROLE_MANAGER_01 정적 계정 없음 — FE-BE-005의 Rate Limit 격리 Fixture 준비 불가',
    })
    return
  }

  await page.goto('/pos/login')
  await page.locator('input[name="tenantCode"]').fill(account.tenantCode)
  await page.locator('input[name="loginId"]').fill(account.loginId)
  await page.locator('input[name="password"]').fill(`${account.password}-wrong`)

  const [loginResponse] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/login',
    ),
    page.locator('button.submit-button').click(),
  ])

  const status = loginResponse.status()
  const errorMessageVisible = await page
    .locator('.form-error[role="alert"]')
    .isVisible()
    .catch(() => false)
  const stillOnLogin = new URL(page.url()).pathname === '/pos/login'
  const cookies = await page.context().cookies()
  const sessionCookieCreated = cookies.some((c) => c.name === 'SESSION')
  const pass = status === 401 && errorMessageVisible && stillOnLogin && !sessionCookieCreated

  record({
    testCaseId: 'FE-BE-005',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_ROLE_MANAGER_01',
    resultCode: pass ? 'PASS' : 'FAIL_UI',
    expected: { requestPath: '/api/v1/auth/login', httpStatus: 401, finalPath: '/pos/login' },
    observed: { httpStatus: status, finalPath: new URL(page.url()).pathname },
    requestId: loginResponse.headers()['x-request-id'] ?? '',
    assertions: {
      status: status === 401,
      errorMessageVisible,
      loginFormRetained: stillOnLogin,
      noSessionCookieCreated: !sessionCookieCreated,
    },
    browser: browserCounts(errors),
    errorClass: pass ? null : status === 429 ? 'AUTH_RATE_LIMITED' : 'UI_ERROR_MESSAGE_MISMATCH',
  })

  expect(
    pass,
    `FE-BE-005 실패: status=${status} errorMessageVisible=${errorMessageVisible} stillOnLogin=${stillOnLogin} sessionCookieCreated=${sessionCookieCreated}`,
  ).toBe(true)
})

test('FE-BE-006 Frontend에서 로그아웃', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  await loginAsAuthValid01(page, env)

  await page.locator('button[aria-label="사용자 메뉴"]').click()
  const [logoutRequest, logoutResponse] = await Promise.all([
    page.waitForRequest((req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/auth/logout'),
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/logout',
    ),
    page.getByRole('button', { name: '로그아웃' }).click(),
  ])

  const csrfHeaderPresent = logoutRequest.headers()['x-xsrf-token'] !== undefined
  const logoutOk = logoutResponse.status() >= 200 && logoutResponse.status() < 300
  await page.waitForURL('**/pos/login')
  const redirectedToLogin = new URL(page.url()).pathname === '/pos/login'

  const protectedResponse = await page.request.get(`${env.apiOrigin}/api/v1/orders`)
  const protectedRejected = protectedResponse.status() === 401

  await page.goBack()
  // 로그아웃 후 보호 화면(/pos/orders)으로 돌아가려 하면 Router Guard가
  // `/pos/login?redirect=/pos/orders`로 되돌린다 — Query String이 붙으므로 `**/pos/login`
  // 같은 "정확히 그 문자열로 끝나야 하는" glob은 매칭되지 않고 goBack() 이후 계속 대기하다가
  // Timeout이 난다(실제로 로컬 리허설에서 재현·확인함). `**` 하나를 더 붙여 Query String
  // 유무와 무관하게 매칭한다.
  await page.waitForURL('**/pos/login**').catch(() => {})
  const backBlocked = new URL(page.url()).pathname === '/pos/login'

  const pass = csrfHeaderPresent && logoutOk && redirectedToLogin && protectedRejected && backBlocked

  record({
    testCaseId: 'FE-BE-006',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode: pass ? 'PASS' : 'FAIL_PROTECTED_FLOW',
    expected: { requestPath: '/api/v1/auth/logout', finalPath: '/pos/login', protectedApiStatus: 401 },
    observed: {
      httpStatus: logoutResponse.status(),
      finalPath: new URL(page.url()).pathname,
      protectedApiStatus: protectedResponse.status(),
    },
    requestId: logoutResponse.headers()['x-request-id'] ?? '',
    assertions: {
      csrfHeaderPresent,
      logoutSucceeded: logoutOk,
      redirectedToLogin,
      protectedApiRejectedAfterLogout: protectedRejected,
      backNavigationBlocked: backBlocked,
    },
    browser: browserCounts(errors),
    errorClass: pass ? null : 'UI_LOGOUT_FAILED',
  })

  expect(
    pass,
    `FE-BE-006 실패: csrf=${csrfHeaderPresent} logoutOk=${logoutOk} redirected=${redirectedToLogin} protectedRejected=${protectedRejected} backBlocked=${backBlocked}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-022: 일별 매출 조회 (Tier A, 비파괴) — 주문 생성/결제(FE-BE-020/021, fe-be-conditional.spec.ts)와
// 함께 검토된 세 번째 화면 여정이지만, 이 케이스는 조회 전용이라 파괴적이지 않다. 영업일
// 마감(POST /sales/daily/{date}/close)은 되돌릴 Endpoint가 없는 회계 확정 동작이라(README.md
// "미구현 항목 설명" D 참고) 이 테스트는 조회(GET /sales/daily)만 검증하고, 마감 버튼에는
// 존재 확인 목적의 클릭을 포함해 어떤 방식으로도 상호작용하는 코드를 두지 않는다.
// ---------------------------------------------------------------------------
const KST_OFFSET_MINUTES = 9 * 60
const KST_MIDNIGHT_SKIP_WINDOW_MINUTES = 5

// api/scenarios/audit-sales-connectivity.js의 storeNow()/todayBusinessDate()/isNearKstMidnight()와
// 동일한 UTC+9 고정 오프셋 트릭(그 파일 79~104행 참고) — AUTH_ROLE_MANAGER_01/OWNER_01 소속 매장이
// Asia/Seoul(UTC+9, DST 없음)이라는 같은 전제. GET /api/v1/sales/daily도
// SalesService.requireCurrentBusinessDate()가 서버가 계산한 "오늘"과 정확히 일치해야 통과시키므로
// (다르면 409) 같은 자정 경계 회피 로직이 필요하다.
function kstNow(): Date {
  return new Date(Date.now() + KST_OFFSET_MINUTES * 60 * 1000)
}
function todayBusinessDateKst(): string {
  return kstNow().toISOString().slice(0, 10)
}
function isNearKstMidnight(): boolean {
  const now = kstNow()
  const minutesSinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes()
  const minutesToNextMidnight = 24 * 60 - minutesSinceMidnight
  return (
    minutesSinceMidnight < KST_MIDNIGHT_SKIP_WINDOW_MINUTES ||
    minutesToNextMidnight <= KST_MIDNIGHT_SKIP_WINDOW_MINUTES
  )
}

test('FE-BE-022 일별 매출 조회', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const httpErrorPaths: string[] = []
  const frontendOrigin = new URL(env.frontendOrigin).origin
  page.on('response', (response: Response) => {
    if (response.status() < 400) return
    const url = new URL(response.url())
    if (url.origin !== frontendOrigin) return
    const path = `${response.status()} ${url.pathname}`
    if (!httpErrorPaths.includes(path)) httpErrorPaths.push(path)
  })
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  // AUTH_ROLE_MANAGER_01을 우선 쓴다 — AUTH_ROLE_OWNER_01은 2026-08-26 결정으로 AUTH_VALID_01과
  // 같은 물리 계정·같은 Rate Limit Bucket을 공유한다(api/README.md "⚠️ 계정 Rate Limit Bucket
  // 주의" 참고). 이 파일의 FE-BE-001~006이 이미 그 Bucket을 여러 번 쓴 직후 이어서 로그인하면
  // 429로 잘못 실패할 위험이 있다 — MANAGER는 별개 물리 계정이라 이 위험이 없으므로 준비돼
  // 있으면 항상 먼저 쓰고, 없을 때만 OWNER로 폴백한다.
  const usingManager = env.staticAccounts.roleManager !== null
  const account = env.staticAccounts.roleManager ?? env.staticAccounts.roleOwner
  if (!account) {
    record({
      testCaseId: 'FE-BE-022',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass:
        'AUTH_ROLE_MANAGER_01/AUTH_ROLE_OWNER_01 정적 계정이 모두 없음 — 매출 조회 화면 접근 전제 불충족',
    })
    return
  }

  if (isNearKstMidnight()) {
    record({
      testCaseId: 'FE-BE-022',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass:
        '자정 경계 근처 실행 회피 — audit-sales-connectivity.js의 SALES-001과 같은 이유' +
        '(SalesService.requireCurrentBusinessDate() 불일치로 인한 409 오탐 방지)',
    })
    return
  }

  await page.goto('/pos/login')
  await page.locator('input[name="tenantCode"]').fill(account.tenantCode)
  await page.locator('input[name="loginId"]').fill(account.loginId)
  await page.locator('input[name="password"]').fill(account.password)

  let loginResponse: Response | null = null
  let transportError: string | null = null
  try {
    ;[loginResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/login',
      ),
      page.locator('button.submit-button').click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const loginStatus = loginResponse?.status() ?? 0
  const loginOk = loginStatus === 200
  const accountAlias = usingManager ? 'AUTH_ROLE_MANAGER_01' : 'AUTH_ROLE_OWNER_01'
  if (!loginOk) {
    record({
      testCaseId: 'FE-BE-022',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias,
      resultCode: transportError ? 'ERROR_TRANSPORT' : 'FAIL_UI',
      expected: { requestPath: '/api/v1/auth/login', httpStatus: 200 },
      observed: { requestPath: '/api/v1/auth/login', httpStatus: loginStatus },
      assertions: { loginSucceeded: false },
      browser: browserCounts(errors),
      errorClass: transportError ? 'UI_API_REQUEST_NOT_SENT' : 'UI_RESPONSE_MAPPING_FAILED',
    })
    expect(
      loginOk,
      `FE-BE-022 실패: 사전 로그인 실패 status=${loginStatus} transportError=${transportError}`,
    ).toBe(true)
    return
  }
  await page.waitForURL('**/pos/orders', { timeout: 10_000 }).catch(() => {})

  const businessDate = todayBusinessDateKst()
  await page.goto('/pos/sales')
  await page.locator('input[type="date"]').fill(businessDate)

  let salesResponse: Response | null = null
  try {
    ;[salesResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/v1/sales/daily',
      ),
      page.getByRole('button', { name: '조회' }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const salesStatus = salesResponse?.status() ?? 0
  const salesOk = salesStatus === 200
  // waitForResponse는 응답 헤더 도착 시점에만 resolve된다 — 그 뒤 Vue가 loading.value=false로
  // 바꾸고 <table class="sales-table">를 실제로 그리기까지는 한 tick 이상의 시간차가 있다.
  // isVisible()은 그 순간 한 번만 확인하는 non-retrying API라 이 시간차를 못 버티고 오탐 FAIL을
  // 낼 수 있으므로, errorLocator와 동일하게(예: 93행) auto-retrying waitFor로 렌더링을 기다린다.
  const tableVisible = salesOk
    ? await page
        .locator('table.sales-table')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
    : false
  const rowCount = tableVisible ? await page.locator('table.sales-table tbody tr').count() : 0
  // 승인 금액·취소 금액·순매출·완료 주문·취소 주문 5개 행이 항상 렌더링된다(SalesClosingView.vue의
  // amountRows() 3행 + 고정 2행 — 실제 소스 확인 완료). 영업일 마감 Button(session.canDoDailyClosing)은
  // 이 판정에도, 이 테스트 어디에도 등장하지 않는다.
  const pass = salesOk && tableVisible && rowCount === 5

  record({
    testCaseId: 'FE-BE-022',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias,
    resultCode: transportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_UI',
    expected: { requestPath: '/api/v1/sales/daily', httpStatus: 200 },
    observed: { requestPath: '/api/v1/sales/daily', httpStatus: salesStatus },
    requestId: salesResponse?.headers()['x-request-id'] ?? '',
    assertions: {
      salesQuerySucceeded: salesOk,
      salesTableVisible: tableVisible,
      salesRowsRendered: rowCount === 5,
    },
    browser: {
      ...browserCounts(errors),
      consoleErrors: sanitizedConsoleErrors(errors.consoleErrors),
      httpErrorPaths: httpErrorPaths.slice(0, 10),
    },
    errorClass: pass ? null : transportError ? 'UI_API_REQUEST_NOT_SENT' : 'UI_RESPONSE_MAPPING_FAILED',
  })

  expect(
    pass,
    `FE-BE-022 실패: salesStatus=${salesStatus} tableVisible=${tableVisible} rowCount=${rowCount} transportError=${transportError}`,
  ).toBe(true)
})
