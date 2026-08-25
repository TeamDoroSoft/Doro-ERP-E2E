import { test, expect, type ConsoleMessage, type Page, type Request, type Response } from '@playwright/test'
import { loadDeployEnv } from '../lib/env'
import { loginAsAuthValid01 } from '../lib/loginFlow'
import { appendCaseResult, type CaseResultInput } from '../lib/resultLogger'

// FE-BE-001~006: 보고서 §5.1 "Frontend–Backend 필수 종단 Gate". Mock, page.route().fulfill(),
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
  let transportError: string | null = null
  try {
    // 로그인 성공 직후 PosOrdersView가 onMounted에서 자동으로 쏘는 GET /api/v1/orders를
    // 놓치지 않으려면, 클릭과 동시에 두 응답을 함께 기다려야 한다.
    ;[loginResponse, ordersResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/login',
      ),
      page.waitForResponse(
        (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/v1/orders',
      ),
      page.locator('button.submit-button').click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

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
  const resultCode = transportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_PROTECTED_FLOW'

  record({
    testCaseId: 'FE-BE-003',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode,
    expected: { requestPath: '/api/v1/orders', protectedApiStatus: 200 },
    observed: { protectedApiPath: ordersResponse ? new URL(ordersResponse.url()).pathname : undefined, protectedApiStatus: ordersStatus },
    requestId: ordersResponse?.headers()['x-request-id'] ?? '',
    assertions: { loginSucceeded: !!loginOk, protectedApiSucceeded: ordersOk, protectedScreenVisible: screenOk },
    browser: browserCounts(errors),
    errorClass: pass ? null : transportError ? 'UI_API_REQUEST_NOT_SENT' : 'UI_PROTECTED_API_FAILED',
  })

  expect(
    pass,
    `FE-BE-003 실패: loginOk=${loginOk} ordersStatus=${ordersStatus} screenOk=${screenOk} transportError=${transportError}`,
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
  const account = env.authValid01

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
    accountAlias: 'AUTH_VALID_01',
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
    errorClass: pass ? null : 'UI_ERROR_MESSAGE_MISMATCH',
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
