import { execFileSync } from 'node:child_process'
import { test, expect, type ConsoleMessage, type Page, type Request } from '@playwright/test'
import { loadDeployEnv } from '../lib/env'
import { appendCaseResult, type CaseResultInput } from '../lib/resultLogger'
import { randomToken, allowLocalSelfSignedCert } from '../lib/provisioning'
import { setupRoleFixtures, type RoleAccount } from '../lib/roleFixtures'

// FE-BE-010~015 (배포 Frontend–Backend 종단 검증.md §4 "조건부 Browser 시나리오"). FE-BE-001~006과 달리 전부
// 조건부다 — Fixture나 안전장치가 없으면 SKIP_PRECONDITION으로 건너뛰고 나머지는 계속 실행한다.

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

async function fillLoginForm(page: Page, tenantCode: string, loginId: string, password: string) {
  await page.locator('input[name="tenantCode"]').fill(tenantCode)
  await page.locator('input[name="loginId"]').fill(loginId)
  await page.locator('input[name="password"]').fill(password)
}

async function submitAndWaitLogin(page: Page) {
  return Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/login',
    ),
    page.locator('button.submit-button').click(),
  ]).then(([res]) => res)
}

async function logout(page: Page) {
  await page.locator('button[aria-label="사용자 메뉴"]').click()
  await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/logout',
    ),
    page.getByRole('button', { name: '로그아웃' }).click(),
  ])
  await page.waitForURL('**/pos/login**')
}

// ---------------------------------------------------------------------------
// FE-BE-013: Browser Network 통제 — 로그인 요청만 연결 차단
// ---------------------------------------------------------------------------
test('FE-BE-013 Network 차단 시 안전한 연결 실패 안내', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  // 실제 계정이 필요 없다 — 요청 자체가 서버에 도달하기 전에 끊긴다. AUTH_VALID_01 Bucket을
  // 건드리지 않으려고 가짜 자격증명을 쓴다.
  await page.route('**/api/v1/auth/login', (route) => route.abort('failed'))

  await page.goto('/pos/login')
  await fillLoginForm(page, 'e2e-network-block-probe', 'probe', 'probe-Password-0013')
  await page.locator('button.submit-button').click()

  const errorLocator = page.locator('.form-error[role="alert"]')
  await errorLocator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const errorText = (await errorLocator.textContent().catch(() => null))?.trim() ?? null
  const stillOnLogin = new URL(page.url()).pathname === '/pos/login'
  const expectedMessage = '인증 서버에 연결할 수 없습니다.'
  const pass = stillOnLogin && errorText === expectedMessage

  record({
    testCaseId: 'FE-BE-013',
    startedAt,
    durationMs: Date.now() - t0,
    resultCode: pass ? 'PASS' : 'FAIL_UI',
    expected: { startPath: '/pos/login' },
    observed: { finalPath: new URL(page.url()).pathname },
    assertions: { loginFormRetained: stillOnLogin, safeMessageShown: errorText === expectedMessage },
    browser: browserCounts(errors),
    errorClass: pass ? null : 'UI_ERROR_MESSAGE_MISMATCH',
  })

  expect(pass, `FE-BE-013 실패: stillOnLogin=${stillOnLogin} errorText="${errorText}"`).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-015: 승인 Redirect Fixture — 안전한 내부 경로만 이동, 외부 Redirect 차단
// ---------------------------------------------------------------------------
test('FE-BE-015 승인된 내부 경로로만 Redirect, 외부 Redirect 차단', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const account = env.authValid01

  // 1) 안전한 내부 경로(/pos/tables — safePosReturnPath가 허용하는 형태)로는 실제로 이동해야 한다.
  await page.goto('/pos/login?redirect=%2Fpos%2Ftables')
  await fillLoginForm(page, account.tenantCode, account.loginId, account.password)
  const loginRes1 = await submitAndWaitLogin(page)
  await page.waitForURL('**/pos/tables', { timeout: 10_000 }).catch(() => {})
  const safePath = new URL(page.url()).pathname
  const safeRedirectOk = loginRes1.status() === 200 && safePath === '/pos/tables'

  await logout(page)

  // 2) 외부/승인되지 않은 Redirect는 무시하고 기본 경로(/pos/orders)로 가야 한다.
  await page.goto('/pos/login?redirect=https%3A%2F%2Fevil.example.com%2Fsteal')
  await fillLoginForm(page, account.tenantCode, account.loginId, account.password)
  const loginRes2 = await submitAndWaitLogin(page)
  await page.waitForURL('**/pos/orders', { timeout: 10_000 }).catch(() => {})
  const finalUrl = page.url()
  const unsafeRedirectBlocked =
    loginRes2.status() === 200 && new URL(finalUrl).pathname === '/pos/orders' && !finalUrl.includes('evil.example.com')

  const pass = safeRedirectOk && unsafeRedirectBlocked

  record({
    testCaseId: 'FE-BE-015',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode: pass ? 'PASS' : 'FAIL_UI',
    expected: { finalPath: '/pos/tables' },
    observed: { finalPath: safePath },
    assertions: { safeRedirectFollowed: safeRedirectOk, unsafeRedirectBlocked },
    browser: browserCounts(errors),
    errorClass: pass ? null : 'UI_REDIRECT_MISMATCH',
  })

  expect(pass, `FE-BE-015 실패: safeRedirectOk=${safeRedirectOk} unsafeRedirectBlocked=${unsafeRedirectBlocked}`).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-011: 안전한 Rate Limit Fixture — 화면에서 제한 응답 유발
// ---------------------------------------------------------------------------
test('FE-BE-011 Rate Limit 유발 시 안전한 재시도 안내', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  // AUTH_VALID_01이 아니라 가짜 전용 계정 하나로 Bucket을 소진한다 — auth-mandatory.js의
  // AUTH-033과 같은 방식(존재 여부와 무관하게 계정 Bucket이 걸린다).
  const tenantCode = `e2e-fe-be-011-${randomToken().slice(0, 10)}`
  const loginId = 'probe'

  await page.goto('/pos/login')
  let lastResponse
  for (let i = 0; i < 6; i++) {
    await fillLoginForm(page, tenantCode, loginId, `wrong-${i}`)
    lastResponse = await submitAndWaitLogin(page)
  }

  const errorLocator = page.locator('.form-error[role="alert"]')
  await errorLocator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const errorText = (await errorLocator.textContent().catch(() => null))?.trim() ?? null
  const expectedMessage = '로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
  const status = lastResponse?.status() ?? 0
  const pass = status === 429 && errorText === expectedMessage

  record({
    testCaseId: 'FE-BE-011',
    startedAt,
    durationMs: Date.now() - t0,
    resultCode: pass ? 'PASS' : 'FAIL_UI',
    expected: { httpStatus: 429 },
    observed: { httpStatus: status },
    requestId: lastResponse?.headers()['x-request-id'] ?? '',
    assertions: { status429: status === 429, safeMessageShown: errorText === expectedMessage },
    browser: browserCounts(errors),
    errorClass: pass ? null : 'UI_ERROR_MESSAGE_MISMATCH',
  })

  expect(pass, `FE-BE-011 실패: status=${status} errorText="${errorText}"`).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-012: Provider 장애 주입 승인 — Login Provider 사용 불가
// ---------------------------------------------------------------------------
const FAULT_INJECTION_FLAG = 'RUN_FAULT_INJECTION_TESTS'
const IS_LOCAL = env.environment.startsWith('local')

// -- 로컬 Docker Prod-like 경로 (기존 그대로) --------------------------------
const STORE_ACCESS_CONTAINER = 'doro-erp-local-apps-store-access-api-1'
const STORE_ACCESS_HEALTH_URL = 'https://localhost:8081/actuator/health'

// docker start는 컨테이너 프로세스 시작만 보장할 뿐, Spring Boot 앱이 요청을 받을 준비가 됐다는
// 뜻은 아니다(로컬에서 실측 24초 안팎 소요) — 이 대기 없이 다음 테스트가 바로 이어지면 FE-BE-010/014가
// 아직 기동 중인 store-access-api에 직접 접속하다가 TLS 연결이 끊긴다.
async function waitForStoreAccessHealthy(timeoutMs = 60_000): Promise<void> {
  allowLocalSelfSignedCert(env)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(STORE_ACCESS_HEALTH_URL)
      if (res.ok) return
    } catch {
      // 재시작 직후 TLS 리스너가 아직 안 열려 있으면 fetch 자체가 실패한다 — 계속 재시도.
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`store-access-api가 ${timeoutMs}ms 안에 다시 healthy 상태가 되지 않았습니다`)
}

// -- 실 배포(EKS) 경로 --------------------------------------------------------
// Doro-ERP-GitOps deploy/base/store-access-api/{deployment,availability,service}.yaml 기준:
// Deployment/HPA/Service가 모두 이름 "store-access-api"이고, overlays/prod/alpha에서
// namespace가 "doro-alpha"로 고정된다. HPA는 minReplicas:2/maxReplicas:4로 CPU(Resource)
// Metric 하나만 보고 Autoscale하므로, 이 값을 그대로 두고 Deployment만 --replicas=0으로
// 내리면 HPA Controller가 곧바로(기본 Sync 주기 15초 안) minReplicas 미달을 감지해 다시
// 올려버린다.
//
// (과거 시도: HPA의 minReplicas를 0으로 먼저 낮춰 "일시 정지"시킨 뒤 Deployment를 내리는
// 방식을 썼었다. 하지만 autoscaling/v2 HPA API는 Object/External 타입 Metric이 최소
// 하나 있어야만 minReplicas:0을 허용하도록 API Server가 검증한다 — 이 HPA는
// Resource(CPU) Metric 하나뿐이라 minReplicas:0 Patch 자체가 API Server에서 거부되어
// 이 경로는 원천적으로 항상 실패했다.)
//
// 그래서 minReplicas를 건드리는 대신 HPA를 통째로 삭제해 Autoscale 통제를 잠깐 없앤
// 다음 Deployment를 --replicas=0으로 내린다. 삭제 전에 HPA의 .spec만 따로 저장해두고
// (metadata.resourceVersion/uid, status 등 서버 관리 필드는 버린다), 검증이 끝나면
// Deployment를 원래 Replicas로 되돌린 뒤 저장해둔 .spec으로 `kubectl apply -f -`에
// Manifest를 흘려보내 HPA를 다시 만든다.
// PodDisruptionBudget(maxUnavailable:1)은 Eviction API 경로에만 적용되고 Deployment
// Scale-down 자체는 막지 않으므로 별도로 다룰 필요가 없다.
//
// 주의: 이 경로는 사설(Private) EKS API Endpoint에 도달 가능한 kubectl context가 필요하다 —
// VPN/Bastion 없이는 이 리포지토리를 작업한 환경에서 전혀 검증할 수 없었다. kubectl이
// 없거나 대상 리소스에 접근할 수 없으면 실행 전 SKIP_PRECONDITION으로 안전하게 건너뛴다.
// 실제 클러스터 접근 권한이 있는 사람이 처음 실행할 때 결과를 반드시 직접 확인할 것.
const K8S_NAMESPACE = process.env.DORO_K8S_NAMESPACE ?? 'doro-alpha'
const K8S_DEPLOYMENT = process.env.DORO_K8S_STORE_ACCESS_DEPLOYMENT ?? 'store-access-api'
const K8S_HPA = process.env.DORO_K8S_STORE_ACCESS_HPA ?? 'store-access-api'

function kubectl(args: string[], opts: { input?: string } = {}): string {
  return execFileSync('kubectl', args, { encoding: 'utf8', ...opts }).trim()
}

function kubectlReachable(): boolean {
  try {
    kubectl(['get', 'deployment', K8S_DEPLOYMENT, '-n', K8S_NAMESPACE, '-o', 'name'])
    kubectl(['get', 'hpa', K8S_HPA, '-n', K8S_NAMESPACE, '-o', 'name'])
    return true
  } catch {
    return false
  }
}

// HPA 삭제 전에 저장해둔 .spec으로 HPA를 다시 만든다 — metadata/status는 서버가 다시
// 채워주므로 이름/namespace만 함께 넣어준다. kubectl apply -f - 는 YAML뿐 아니라 JSON도
// 그대로 받아들인다(scripts/verify-provider-malformed-response.mjs의 applyDecoyPod()와
// 동일하게 execFileSync에 input으로 Manifest 문자열을 흘려보내는 방식).
function restoreHpa(spec: unknown): void {
  const manifest = JSON.stringify({
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: K8S_HPA, namespace: K8S_NAMESPACE },
    spec,
  })
  kubectl(['apply', '-f', '-'], { input: manifest })
}

async function waitForReadyReplicas(target: number, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const raw = kubectl([
      'get', 'deployment', K8S_DEPLOYMENT, '-n', K8S_NAMESPACE,
      '-o', 'jsonpath={.status.readyReplicas}',
    ])
    if (Number(raw || '0') === target) return true
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

test('FE-BE-012 Provider 장애 시 안전한 서비스 불가 안내', async ({ page }) => {
  // store-access-api 재기동에 로컬 실측 약 24초가 걸린다(finally의 복구 대기) — 실 배포 경로는
  // Pod 재기동까지 더 오래 걸릴 수 있어 여유를 더 크게 잡는다.
  test.setTimeout(180_000)
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  if (process.env[FAULT_INJECTION_FLAG] !== 'true') {
    record({
      testCaseId: 'FE-BE-012',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass: `${FAULT_INJECTION_FLAG}=true로 명시하지 않으면 실행하지 않음 (배포 Frontend–Backend 종단 검증.md §4 "Provider 장애를 임의로 유발하지 않는다", ${IS_LOCAL ? '로컬 Docker 컨테이너' : `실 배포 EKS의 ${K8S_NAMESPACE}/${K8S_DEPLOYMENT} Deployment`}를 실제로 멈춤)`,
    })
    return
  }

  if (!IS_LOCAL && !kubectlReachable()) {
    record({
      testCaseId: 'FE-BE-012',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass: `kubectl로 ${K8S_NAMESPACE} 네임스페이스의 Deployment/HPA "${K8S_DEPLOYMENT}"에 접근할 수 없음 — 실 배포 대상 Provider 장애 주입에는 EKS 사설 API Endpoint에 도달 가능한 kubectl context가 필요하다(VPN/Bastion 필요).`,
    })
    return
  }

  let originalReplicas: string | null = null
  let hpaSpec: unknown = null
  let hpaDeleted = false

  // HPA 삭제와 Deployment 원복을 한데 묶은 최선 노력(Best-effort) 복구 — 두 단계 중
  // 하나가 실패해도 나머지는 계속 시도한다(둘 다 시도하지 않으면 Deployment가 0에
  // 머물거나 HPA가 없는 채로 남을 수 있다).
  function restoreNonLocal(): void {
    if (originalReplicas !== null) {
      try {
        kubectl(['scale', 'deployment', K8S_DEPLOYMENT, '-n', K8S_NAMESPACE, `--replicas=${originalReplicas}`])
      } catch (err) {
        console.error(
          `⚠ ${K8S_NAMESPACE}/${K8S_DEPLOYMENT} replicas를 ${originalReplicas}(으)로 복구하지 못했습니다 — 수동 확인 필요: ` +
            (err instanceof Error ? err.message : String(err)),
        )
      }
    }
    if (hpaDeleted && hpaSpec !== null) {
      try {
        restoreHpa(hpaSpec)
      } catch (err) {
        console.error(
          `⚠ ${K8S_NAMESPACE}/${K8S_HPA} HPA를 재생성하지 못했습니다 — 수동 확인 필요: ` +
            (err instanceof Error ? err.message : String(err)),
        )
      }
    }
  }

  if (IS_LOCAL) {
    execFileSync('docker', ['stop', STORE_ACCESS_CONTAINER])
  } else {
    // 이 지점부터 HPA 삭제/Deployment Scale-down이 끝나는 지점까지 어디서 던져도(kubectl
    // delete/scale 자체가 실패하는 경우 포함) 이미 바뀐 것만큼은 반드시 원복을 시도한다.
    try {
      originalReplicas = kubectl(['get', 'deployment', K8S_DEPLOYMENT, '-n', K8S_NAMESPACE, '-o', 'jsonpath={.spec.replicas}'])
      hpaSpec = JSON.parse(kubectl(['get', 'hpa', K8S_HPA, '-n', K8S_NAMESPACE, '-o', 'json'])).spec
      kubectl(['delete', 'hpa', K8S_HPA, '-n', K8S_NAMESPACE])
      hpaDeleted = true
      kubectl(['scale', 'deployment', K8S_DEPLOYMENT, '-n', K8S_NAMESPACE, '--replicas=0'])
      const wentDown = await waitForReadyReplicas(0)
      if (!wentDown) {
        throw new Error(`${K8S_NAMESPACE}/${K8S_DEPLOYMENT}의 readyReplicas가 0으로 내려가지 않았습니다.`)
      }
    } catch (err) {
      // 복구 없이 그냥 멈추면 실 서비스가 계속 죽어 있게 되므로, 던지기 전에 즉시 원복부터 시도한다.
      restoreNonLocal()
      throw err
    }
  }

  try {
    await page.goto('/pos/login')
    await fillLoginForm(page, 'e2e-fe-be-012-probe', 'probe', 'probe-Password-0012')
    const res = await submitAndWaitLogin(page)

    const errorLocator = page.locator('.form-error[role="alert"]')
    await errorLocator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    const errorText = (await errorLocator.textContent().catch(() => null))?.trim() ?? null
    const expectedMessage = '직원 로그인 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
    const status = res.status()
    const pass = status === 503 && errorText === expectedMessage

    record({
      testCaseId: 'FE-BE-012',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_UI',
      expected: { httpStatus: 503 },
      observed: { httpStatus: status },
      requestId: res.headers()['x-request-id'] ?? '',
      assertions: { status503: status === 503, safeMessageShown: errorText === expectedMessage },
      browser: browserCounts(errors),
      errorClass: pass ? null : 'UI_ERROR_MESSAGE_MISMATCH',
    })

    expect(pass, `FE-BE-012 실패: status=${status} errorText="${errorText}"`).toBe(true)
  } finally {
    if (IS_LOCAL) {
      execFileSync('docker', ['start', STORE_ACCESS_CONTAINER])
      await waitForStoreAccessHealthy()
    } else {
      restoreNonLocal()
      const recovered = await waitForReadyReplicas(Number(originalReplicas))
      if (!recovered) {
        throw new Error(
          `${K8S_NAMESPACE}/${K8S_DEPLOYMENT}가 원래 readyReplicas(${originalReplicas})로 복구되지 않았습니다 — 직접 확인이 필요합니다.`,
        )
      }
    }
  }
})

// ---------------------------------------------------------------------------
// FE-BE-010: 임시 비밀번호 Fixture — 화면 로그인 → 비밀번호 변경 화면 이동
// ---------------------------------------------------------------------------
test('FE-BE-010 임시 비밀번호 계정 로그인 시 비밀번호 변경 화면으로 이동', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  const account = env.staticAccounts.tempPassword
  if (!account) {
    record({
      testCaseId: 'FE-BE-010',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass: 'AUTH_TEMP_PASSWORD_01 정적 계정 없음 — 임시 비밀번호 Fixture 준비 불가',
    })
    return
  }

  let pass = false
  let status = 0
  let finalPath = ''
  try {
    await page.goto('/pos/login')
    await fillLoginForm(page, account.tenantCode, account.loginId, account.password)
    const res = await submitAndWaitLogin(page)
    status = res.status()

    await page.waitForURL('**/pos/account/change-password', { timeout: 10_000 }).catch(() => {})
    finalPath = new URL(page.url()).pathname
    pass = status === 200 && finalPath === '/pos/account/change-password'

    record({
      testCaseId: 'FE-BE-010',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_UI',
      expected: { httpStatus: 200, finalPath: '/pos/account/change-password' },
      observed: { httpStatus: status, finalPath },
      requestId: res.headers()['x-request-id'] ?? '',
      assertions: { status200: status === 200, redirectedToChangePassword: finalPath === '/pos/account/change-password' },
      browser: browserCounts(errors),
      errorClass: pass ? null : 'UI_REDIRECT_MISMATCH',
    })
  } catch (error) {
    record({
      testCaseId: 'FE-BE-010',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: 'ERROR_TRANSPORT',
      errorClass: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  expect(pass, `FE-BE-010 실패: status=${status} finalPath="${finalPath}"`).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-014: Role별 Fixture — 허용 메뉴·보호 Route 일치
// ---------------------------------------------------------------------------
test('FE-BE-014 Role별 허용 메뉴와 보호 Route 일치', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  const { roleOwner, roleManager, roleStaff } = env.staticAccounts
  const hasStaticRoleAccounts = roleOwner !== null && roleManager !== null && roleStaff !== null
  if (!hasStaticRoleAccounts) {
    record({
      testCaseId: 'FE-BE-014',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass: 'AUTH_ROLE_OWNER_01/MANAGER_01/STAFF_01 정적 계정 없음 — OWNER/MANAGER/STAFF Fixture 준비 불가',
    })
    return
  }

  async function loginAndCheckTablesMenu(account: RoleAccount): Promise<boolean> {
    await page.goto('/pos/login')
    await fillLoginForm(page, account.tenantCode, account.loginId, account.password)
    await submitAndWaitLogin(page)
    await page.waitForURL('**/pos/orders', { timeout: 10_000 })
    // posNavigation.ts: "테이블"(/pos/tables)은 OWNER/MANAGER 전용 — STAFF에게는 안 보여야 한다.
    return page
      .locator('nav a[href="/pos/tables"]')
      .isVisible()
      .catch(() => false)
  }

  let pass = false
  let staffBlockedPath = ''
  let staffBlockedReason: string | null = null
  try {
    const fixtures = await setupRoleFixtures(env)

    const ownerHasTablesMenu = await loginAndCheckTablesMenu(fixtures.owner)
    await logout(page)

    const managerHasTablesMenu = await loginAndCheckTablesMenu(fixtures.manager)
    await logout(page)

    const staffHasTablesMenu = await loginAndCheckTablesMenu(fixtures.staff)
    // 메뉴에 없어도 직접 URL로 접근을 시도하면 router/index.ts의 Role Guard가
    // /pos/orders?reason=forbidden으로 되돌려야 한다(§실제 구현 확인 완료).
    await page.goto('/pos/tables')
    const url = new URL(page.url())
    staffBlockedPath = url.pathname
    staffBlockedReason = url.searchParams.get('reason')

    pass =
      ownerHasTablesMenu === true &&
      managerHasTablesMenu === true &&
      staffHasTablesMenu === false &&
      staffBlockedPath === '/pos/orders' &&
      staffBlockedReason === 'forbidden'

    record({
      testCaseId: 'FE-BE-014',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_UI',
      expected: { finalPath: '/pos/orders' },
      observed: { finalPath: staffBlockedPath },
      assertions: {
        ownerHasTablesMenu,
        managerHasTablesMenu,
        staffHasTablesMenuAbsent: staffHasTablesMenu === false,
        staffDirectAccessBlocked: staffBlockedPath === '/pos/orders' && staffBlockedReason === 'forbidden',
      },
      browser: browserCounts(errors),
      errorClass: pass ? null : 'UI_RESPONSE_MAPPING_FAILED',
    })
  } catch (error) {
    record({
      testCaseId: 'FE-BE-014',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: 'ERROR_TRANSPORT',
      errorClass: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  expect(pass, `FE-BE-014 실패: staffBlockedPath="${staffBlockedPath}" staffBlockedReason="${staffBlockedReason}"`).toBe(true)
})
