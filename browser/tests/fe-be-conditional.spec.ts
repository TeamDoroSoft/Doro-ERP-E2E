import { execFileSync } from 'node:child_process'
import { test, expect, type ConsoleMessage, type Page, type Request, type Response } from '@playwright/test'
import { loadDeployEnv } from '../lib/env'
import { loginAsAuthValid01 } from '../lib/loginFlow'
import { appendCaseResult, type CaseResultInput } from '../lib/resultLogger'
import { randomToken, allowLocalSelfSignedCert } from '../lib/provisioning'
import { setupRoleFixtures, type RoleAccount } from '../lib/roleFixtures'

// FE-BE-010~015,020,021,023~027 (조건부 Browser 시나리오). FE-BE-001~006과 달리 전부
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
  // 실측 확인(2026-08-27): 프론트(Doro-ERP-Front/src/views/LoginView.vue의 NETWORK_ERROR 분기)의
  // 실제 문구가 이걸로 바뀌어 있었다 — 옛 기대값("인증 서버에 연결할 수 없습니다.")은 테스트가
  // UI 변경을 못 따라간 것이었다(애플리케이션 쪽 결함이 아님, 직접 소스 대조로 확인 완료).
  const expectedMessage = '로그인할 수 없습니다. 연결 상태를 확인해 주세요.'
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

// ---------------------------------------------------------------------------
// FE-BE-020/021/024: 주문 생성·취소 → 결제 시작·복구 (Tier B, 파괴적) — RUN_DESTRUCTIVE_ORDER_TESTS 필요
//
// 주문 취소 API(POST /api/v1/orders/{orderId}/cancel, Doro-ERP-Front src/api/order.ts의
// cancelOrder())가 실제로 존재함을 확인했다(EdgeOrderController.java → commerce-api
// OrderController.java → OrderService.cancel()). 다만 DELETE가 아니라 status만 CANCELLED로
// 바꾸는 소프트 취소이고, order_status_history에 생성·취소 이력이 영구히 남는다(commerce-api
// OrderService.java/Order.java 직접 확인 완료) — QUEUE-003/CATALOG-004~006과 같은 "취소·비활성화는
// 되지만 이력은 영구 잔존" 패턴이다. 또한 cancelBeforePayment()는 주문 status가 정확히 CREATED일
// 때만 성공하고(그 외엔 409 INVALID_STATE), 멱등이 아니다 — 이미 CANCELLED인 주문에 다시 호출해도
// 409다. Role 제한은 없다(로그인한 직원이면 역할 무관).
//
// 그래서 아래 세 테스트는 각자 만든 주문을 테스트 마지막에 이 API로 취소해
// 실 테넌트에 CREATED 상태 주문이 방치되지 않게 한다(QUEUE-003의 try/finally 정리 철학과 동일) —
// 다만 정리에 성공해도 취소 이력 자체는 영구히 남고, FE-BE-021처럼 결제(Payment)가 이미 생성된
// 뒤에는 정리 취소가 409로 거절될 수 있다(아래 FE-BE-021 주석 참고) — 그 경우 실 테넌트에 CREATED
// 주문과 PENDING 결제가 영구히 남는다.
// ---------------------------------------------------------------------------
const DESTRUCTIVE_ORDER_FLAG = 'RUN_DESTRUCTIVE_ORDER_TESTS'

interface CreateOrderUiResult {
  status: number
  orderId: string
  transportError: string | null
  skipReason: string | null
}

// PosOrderCreateView.vue를 그대로 따른다 — 기본 주문 방식이 TAKEOUT이라 테이블 선택이 필요 없고
// (useOrderDraft.ts 확인 완료), 카탈로그 메뉴가 하나도 없으면(EmptyState) 담을 상품이 없어 SKIP한다.
async function createOrderViaUi(page: Page): Promise<CreateOrderUiResult> {
  await page.goto('/pos/orders/new')

  const emptyState = await page
    .getByText('판매할 메뉴가 없습니다.')
    .isVisible()
    .catch(() => false)
  if (emptyState) {
    return {
      status: 0,
      orderId: '',
      transportError: null,
      skipReason: 'AUTH_VALID_01 테넌트에 판매 가능한 메뉴가 없어 주문을 만들 상품이 없음',
    }
  }

  await page.getByRole('button', { name: '담기' }).first().click()

  let createResponse: Response | null = null
  let transportError: string | null = null
  try {
    ;[createResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/orders',
      ),
      page.getByRole('button', { name: '주문 등록' }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const status = createResponse?.status() ?? 0
  let orderId = ''
  if (status === 201) {
    // submit() 성공 시 router.push({ name: 'pos-orders-detail', params: { orderId } })로 이동한다
    // (PosOrderCreateView.vue 확인 완료) — 이 이동 자체가 "주문이 성공적으로 생성됐다"는 화면상의
    // 실제 신호다.
    //
    // 주의: 시작 시점의 URL이 이미 /pos/orders/new이고, 이 경로 자체가 아래 정규식(세그먼트 하나)을
    // 만족한다 — waitForURL(pattern)은 "현재 URL이 이미 패턴과 일치하면 즉시 resolve"하는 상태
    // 확인이라(실제 Navigation을 기다리는 게 아님), "new"를 제외해두지 않으면 실제 주문 상세로
    // Navigation이 일어나기 전에 곧바로 통과해버려 orderId에 실제 UUID 대신 문자열 "new"가 담긴다
    // (실 배포 실측으로 확인된 결함 — 이 값이 그대로 cancelOrderViaUi에 넘어가면 존재하지 않는
    // /api/v1/orders/new/cancel을 호출해 정리에 실패하고 실 테넌트에 주문/결제가 남는다).
    await page.waitForURL(/\/pos\/orders\/(?!new$)[^/]+$/, { timeout: 10_000 }).catch(() => {})
    const matchedOrderId = new URL(page.url()).pathname.match(/\/pos\/orders\/([^/]+)$/)?.[1] ?? ''
    // 이중 방어 — 정규식이 어떤 이유로든 "new"를 다시 통과시키더라도 호출부에는 절대 넘기지 않는다.
    orderId = matchedOrderId === 'new' ? '' : matchedOrderId
  }
  return { status, orderId, transportError, skipReason: null }
}

// OrderDetailPanel.vue: "주문 취소" Button은 order.status === 'CREATED'일 때만 렌더링되고, 클릭 시
// window.confirm()으로 먼저 확인한다(PosOrderDetailView.vue의 cancel() 확인 완료) — dialog 이벤트를
// 미리 accept로 등록해둔다.
async function cancelOrderViaUi(page: Page, orderId: string): Promise<number> {
  page.once('dialog', (dialog) => void dialog.accept())
  const [cancelResponse] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === `/api/v1/orders/${orderId}/cancel`,
    ),
    page.getByRole('button', { name: '주문 취소' }).click(),
  ])
  return cancelResponse.status()
}

test('FE-BE-020 화면에서 새 주문 생성 후 취소', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  if (process.env[DESTRUCTIVE_ORDER_FLAG] !== 'true') {
    record({
      testCaseId: 'FE-BE-020',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass:
        `${DESTRUCTIVE_ORDER_FLAG}=true로 명시하지 않으면 실행하지 않음 — 주문 취소 API는 성공해도 ` +
        'order_status_history에 생성·취소 이력이 영구히 남는 소프트 취소라(위 파일 상단 주석 참고) 파괴적으로 분류했다.',
    })
    return
  }

  await loginAsAuthValid01(page, env)
  const { status, orderId, transportError, skipReason } = await createOrderViaUi(page)

  if (skipReason) {
    record({
      testCaseId: 'FE-BE-020',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: 'SKIP_PRECONDITION',
      errorClass: skipReason,
    })
    return
  }

  // 정리(cleanup) 시도 여부는 서버에 주문이 실제로 생성됐는지(status 201 + orderId 확보)로만
  // 판단한다 — 아래 detailVisible(순전히 UI 렌더링 확인)과는 완전히 독립시킨다. 그렇지 않으면
  // 실 배포 실측대로(2026-08-27) detailVisible이 타이밍 문제로 false가 되는 순간 서버에는 주문이
  // 실제로 생겼는데도 정리 시도 자체가 스킵되어 실 테넌트에 주문이 방치된다.
  const shouldAttemptCleanup = status === 201 && orderId !== ''
  // waitForResponse는 응답 헤더 도착 시점에만 resolve된다 — 그 뒤 Vue Router가 주문 상세로
  // Navigation하고 <article class="order-detail">을 실제로 그리기까지 시간차가 있다. isVisible()은
  // 그 순간 한 번만 확인하는 non-retrying API라 이 시간차를 못 버티고 오탐 FAIL을 낼 수 있다
  // (FE-BE-022를 고친 bfa9ba9와 같은 원인, 실 배포 실측으로 재확인). errorLocator/salesTable과
  // 동일하게 auto-retrying waitFor로 렌더링을 기다린다.
  const detailVisible = shouldAttemptCleanup
    ? await page
        .locator('article.order-detail')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
    : false
  const created = status === 201 && orderId !== '' && detailVisible

  let cleanupCancelStatus = 0
  let cancelledStatusVisible = false
  if (shouldAttemptCleanup) {
    try {
      cleanupCancelStatus = await cancelOrderViaUi(page, orderId)
      cancelledStatusVisible =
        cleanupCancelStatus === 200
          ? await page
              .locator('article.order-detail')
              .getByText('취소', { exact: true })
              .waitFor({ state: 'visible', timeout: 5_000 })
              .then(() => true)
              .catch(() => false)
          : false
    } catch (error) {
      console.error(
        `⚠ FE-BE-020이 만든 주문(${orderId})을 정리(취소)하지 못했습니다 — 실 테넌트에 CREATED ` +
          `상태로 남아있을 수 있어 수동 확인이 필요합니다: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const orderCancelled = cleanupCancelStatus === 200 && cancelledStatusVisible
  const pass = created && orderCancelled && !transportError

  record({
    testCaseId: 'FE-BE-020',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode: transportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_UI',
    expected: { requestPath: '/api/v1/orders', httpStatus: 201, finalPath: orderId ? `/pos/orders/${orderId}` : undefined },
    observed: {
      requestPath: '/api/v1/orders',
      httpStatus: status,
      finalPath: orderId ? new URL(page.url()).pathname : undefined,
    },
    assertions: {
      orderCreated: status === 201,
      orderDetailVisible: detailVisible,
      orderCancelledViaUi: cleanupCancelStatus === 200,
      cancelledStatusVisible,
    },
    browser: browserCounts(errors),
    errorClass: pass
      ? null
      : transportError
        ? 'UI_API_REQUEST_NOT_SENT'
        : created
          ? 'UI_ORDER_CANCEL_FAILED'
          : 'UI_ORDER_CREATE_FAILED',
  })

  expect(
    pass,
    `FE-BE-020 실패: status=${status} orderId="${orderId}" detailVisible=${detailVisible} ` +
      `cancelStatus=${cleanupCancelStatus} cancelledStatusVisible=${cancelledStatusVisible} transportError=${transportError}`,
  ).toBe(true)
})

test('FE-BE-021 결제 시작 시 Toss 결제창 연동 확인', async ({ page, context }) => {
  test.setTimeout(60_000)
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  if (process.env[DESTRUCTIVE_ORDER_FLAG] !== 'true') {
    record({
      testCaseId: 'FE-BE-021',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass: `${DESTRUCTIVE_ORDER_FLAG}=true로 명시하지 않으면 실행하지 않음 — FE-BE-020과 같은 이유로 이 케이스도 새 주문을 만든다.`,
    })
    return
  }

  await loginAsAuthValid01(page, env)
  const created = await createOrderViaUi(page)

  if (created.skipReason) {
    record({
      testCaseId: 'FE-BE-021',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: 'SKIP_PRECONDITION',
      errorClass: created.skipReason,
    })
    return
  }
  if (created.status !== 201 || !created.orderId) {
    record({
      testCaseId: 'FE-BE-021',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: created.transportError ? 'ERROR_TRANSPORT' : 'FAIL_UI',
      errorClass: 'FE-BE-021의 전제조건인 주문 생성 실패 — FE-BE-020 참고',
    })
    expect(
      false,
      `FE-BE-021 실패: 결제 시나리오의 전제조건인 주문 생성에 실패했습니다 (status=${created.status})`,
    ).toBe(true)
    return
  }
  const orderId = created.orderId

  let payButtonError: string | null = null
  let tossConfigError = false
  let paymentCreateStatus = 0
  let tossWidgetSignal: 'popup' | 'iframe' | null = null
  let cleanupCancelStatus = 0
  let cleanupCancelError: string | null = null

  try {
    // OrderPaymentPanel.vue의 startTossPayment(): VITE_TOSS_CLIENT_KEY가 비어 있으면 결제(Payment)
    // API를 아예 호출하지 않고 곧바로 '.payment-panel__error'에 안내 문구를 띄운다 — 이 저장소
    // 코드로는 고칠 수 없는 배포 빌드 설정 문제이므로 SKIP으로 구분한다.
    const configErrorLocator = page.locator('.payment-panel__error', { hasText: '결제를 시작할 수 없습니다' })

    const [paymentResponse] = await Promise.all([
      page
        .waitForResponse(
          (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/payments',
          { timeout: 10_000 },
        )
        .catch(() => null),
      page.getByRole('button', { name: '결제하기' }).click(),
    ])

    paymentCreateStatus = paymentResponse?.status() ?? 0

    if (paymentCreateStatus === 0) {
      tossConfigError = await configErrorLocator.isVisible().catch(() => false)
    } else if (paymentCreateStatus === 201) {
      // 판단 근거(정직하게 여기까지만 자동화한 이유): tossPayment.ts는 @tosspayments/tosspayments-sdk의
      // loadTossPayments()로 https://js.tosspayments.com/v2/standard 스크립트를 동적으로 <script> 태그로
      // 주입하고(SDK dist 코드 확인 완료 — 이 저장소 코드에는 그 스크립트가 만드는 DOM 구조가 전혀
      // 없다), widgets.renderPaymentWindow()가 반환하는 "결제창" UI가 같은 페이지 안에 인라인
      // iframe으로 뜨는지 별도 팝업(새 창/탭)으로 뜨는지는 Toss가 배포한 원격 SDK 버전에 달려 있어
      // 이 코드베이스만 보고는 확정할 수 없다. 그 내부 DOM(카드사 선택, 약관 동의, 승인 버튼 등)은
      // Toss가 소유한 Cross-Origin 콘텐츠라 셀렉터가 예고 없이 바뀔 수 있고, 여기서 실제 결제
      // 승인까지 밀어붙이면 Flaky한 테스트가 된다 — 그래서 결제창이 실제로 열리기 시작했다는 신호
      // (새 Page 이벤트 또는 tosspayments.com iframe 삽입) 중 하나가 나타나는 것까지만 확인하고
      // 멈춘다. 카드 정보 입력이나 결제 승인 Button 클릭은 절대 하지 않는다(test_gck_ 접두사
      // 강제 검증 — tossPayment.ts의 tossSafeAmount()/clientKey 정규식 확인 완료 — 이 때문에 설령
      // 끝까지 진행해도 실결제는 발생하지 않지만, 그것과 별개로 위 이유로 여기서 멈춘다).
      const popupSignal = context
        .waitForEvent('page', { timeout: 15_000 })
        .then(() => 'popup' as const)
        .catch(() => null)
      const iframeSignal = page
        .waitForSelector('iframe[src*="tosspayments.com"]', { timeout: 15_000 })
        .then(() => 'iframe' as const)
        .catch(() => null)
      tossWidgetSignal = await Promise.race([popupSignal, iframeSignal])
    }
  } catch (error) {
    payButtonError = error instanceof Error ? error.message : String(error)
  } finally {
    // 결제(Payment)가 PENDING으로 생성된 뒤에도 주문 status는 여전히 CREATED다(useOrderPayment.ts의
    // canCreate가 order.status==='CREATED'를 전제로 결제 생성 버튼을 노출하는 것으로 확인 완료) —
    // 그래서 정리 취소를 그대로 시도한다. 만약 실제로는 결제 생성이 주문을 다른 status로 옮기거나
    // 사이드이펙트가 있다면 이 취소 호출이 409로 거절될 수 있고, 그 경우 실 테넌트에 CREATED 주문과
    // PENDING 결제가 영구히 남는다.
    //
    // 실 배포에 --trace on으로 재실행해 Network 로그를 직접 확인한 결과(2026-08-27): 결제 생성 직후
    // Toss 결제창은 팝업이 아니라 인라인 iframe(GET .../v2/entry/payment-window, 관련 리소스
    // 80개 이상)으로 같은 화면 위에 떠 있었고, 그 상태에서 그대로 "주문 취소"를 클릭해도
    // POST /api/v1/orders/{id}/cancel이 Trace 전체에 단 한 번도 나타나지 않았다 — Toss iframe이
    // OrderDetailPanel의 취소 Button 위를 시각적으로 덮거나 레이아웃을 밀어내 클릭이 의도대로
    // 작동하지 않은 것으로 보인다. PosOrderDetailView.vue의 loadOrder() 주석대로 이 화면을 Route
    // Navigation이 아니라 처음부터 다시 불러오면(showLoading=true 경로, `order.value = null` →
    // `loading.value = true`) 아래 템플릿의 `v-else-if="order"` 분기가 OrderPaymentPanel(그
    // 안의 Toss iframe 포함)을 완전히 unmount하고, 응답이 오면 OrderDetailPanel만 깨끗하게 다시
    // mount한다 — 그래서 정리 클릭 직전에 주문 상세를 처음부터 다시 불러온다.
    try {
      await page.goto(`/pos/orders/${orderId}`)
      await page.locator('article.order-detail').waitFor({ state: 'visible', timeout: 10_000 })
      cleanupCancelStatus = await cancelOrderViaUi(page, orderId)
    } catch (error) {
      cleanupCancelError = error instanceof Error ? error.message : String(error)
      console.error(
        `⚠ FE-BE-021이 만든 주문(${orderId})을 정리(취소)하지 못했습니다 — PENDING 결제가 연결돼 ` +
          `있으면 주문 취소 API가 409로 거절할 수 있고, 이 경우 실 테넌트에 CREATED 주문과 PENDING ` +
          `결제가 영구히 남습니다. 수동 확인 필요: ${cleanupCancelError}`,
      )
    }
  }

  const pass = !payButtonError && !tossConfigError && paymentCreateStatus === 201 && tossWidgetSignal !== null
  const resultCode = tossConfigError
    ? 'SKIP_PRECONDITION'
    : payButtonError
      ? 'ERROR_TRANSPORT'
      : pass
        ? 'PASS'
        : 'FAIL_UI'

  record({
    testCaseId: 'FE-BE-021',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode,
    expected: { requestPath: '/api/v1/payments', httpStatus: 201 },
    observed: { requestPath: '/api/v1/payments', httpStatus: paymentCreateStatus },
    assertions: {
      paymentCreated: paymentCreateStatus === 201,
      tossWidgetSignalObserved: tossWidgetSignal !== null,
      cleanupCancelSucceeded: cleanupCancelStatus === 200,
    },
    browser: browserCounts(errors),
    errorClass: tossConfigError
      ? 'VITE_TOSS_CLIENT_KEY 미설정(또는 형식 오류) — 배포 Frontend 빌드 설정 확인 필요'
      : pass
        ? null
        : 'UI_TOSS_WIDGET_NOT_OBSERVED',
  })

  if (resultCode === 'SKIP_PRECONDITION') return
  expect(
    pass,
    `FE-BE-021 실패: paymentCreateStatus=${paymentCreateStatus} tossWidgetSignal=${tossWidgetSignal} ` +
      `payButtonError=${payButtonError} cleanupCancelStatus=${cleanupCancelStatus}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-024: PENDING 결제 새로고침 복구 (Tier B, 파괴적) — RUN_DESTRUCTIVE_ORDER_TESTS 필요
//
// FE-BE-021이 결제 생성과 Toss 창 연결 시작까지만 검증한다면, 이 케이스는 그 직후 주문 상세를
// 새로 불러왔을 때 Front가 최근 paymentId 또는 GET /payments/by-order/{orderId}로 기존 PENDING
// 결제를 다시 찾고 두 번째 POST /payments 없이 "결제 계속하기"를 노출하는지 검증한다.
// ---------------------------------------------------------------------------
test('FE-BE-024 새로고침 후 기존 PENDING 결제 복구', async ({ page }) => {
  test.setTimeout(60_000)
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  if (process.env[DESTRUCTIVE_ORDER_FLAG] !== 'true') {
    record({
      testCaseId: 'FE-BE-024',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass:
        `${DESTRUCTIVE_ORDER_FLAG}=true로 명시하지 않으면 실행하지 않음 — 새 주문과 PENDING 결제를 ` +
        '생성하고 주문 취소 이력이 영구히 남는다.',
    })
    return
  }

  await loginAsAuthValid01(page, env)
  const created = await createOrderViaUi(page)
  if (created.skipReason) {
    record({
      testCaseId: 'FE-BE-024',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: 'SKIP_PRECONDITION',
      errorClass: created.skipReason,
    })
    return
  }
  if (created.status !== 201 || !created.orderId) {
    record({
      testCaseId: 'FE-BE-024',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: created.transportError ? 'ERROR_TRANSPORT' : 'FAIL_UI',
      errorClass: 'FE-BE-024의 전제조건인 주문 생성 실패 — FE-BE-020 참고',
    })
    expect(false, `FE-BE-024 실패: 주문 생성 status=${created.status}`).toBe(true)
    return
  }

  const orderId = created.orderId
  let paymentCreateCount = 0
  const countPaymentCreate = (request: Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/payments') {
      paymentCreateCount += 1
    }
  }
  page.on('request', countPaymentCreate)

  let paymentCreateStatus = 0
  let paymentId = ''
  let paymentStatus = ''
  let recoveryStatus = 0
  let recoveredPaymentStatus = ''
  let resumeButtonVisible = false
  let tossConfigError = false
  let cleanupCancelStatus = 0
  let transportError: string | null = null
  let requestId = ''

  try {
    const [createResponse] = await Promise.all([
      page
        .waitForResponse(
          (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/payments',
          { timeout: 10_000 },
        )
        .catch(() => null),
      page.getByRole('button', { name: '결제하기' }).click(),
    ])

    paymentCreateStatus = createResponse?.status() ?? 0
    requestId = createResponse?.headers()['x-request-id'] ?? ''
    if (!createResponse) {
      tossConfigError = await page
        .locator('.payment-panel__error', { hasText: '결제를 시작할 수 없습니다' })
        .isVisible()
        .catch(() => false)
    } else if (paymentCreateStatus === 201) {
      const body = await createResponse.json().catch(() => null)
      paymentId = typeof body?.id === 'string' ? body.id : ''
      paymentStatus = typeof body?.status === 'string' ? body.status : ''

      // 원격 Toss SDK가 iframe을 붙이는 동안 즉시 Navigation하면 정상적인 SDK Request까지
      // requestfailed로 기록될 수 있다. 실제 결제 승인은 하지 않되 렌더 시작만 짧게 기다린다.
      await page.waitForSelector('iframe[src*="tosspayments.com"]', { timeout: 10_000 }).catch(() => null)

      let recoveryResponse: Response | null = null
      ;[recoveryResponse] = await Promise.all([
        page.waitForResponse(
          (res) => {
            if (res.request().method() !== 'GET') return false
            const path = new URL(res.url()).pathname
            return (
              (paymentId !== '' && path === `/api/v1/payments/${paymentId}`) ||
              path === `/api/v1/payments/by-order/${orderId}`
            )
          },
          { timeout: 10_000 },
        ),
        page.goto(`/pos/orders/${orderId}`),
      ])

      recoveryStatus = recoveryResponse.status()
      requestId = recoveryResponse.headers()['x-request-id'] ?? requestId
      const recoveredBody = await recoveryResponse.json().catch(() => null)
      recoveredPaymentStatus = typeof recoveredBody?.status === 'string' ? recoveredBody.status : ''
      resumeButtonVisible = await page
        .getByRole('button', { name: '결제 계속하기' })
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
    }
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  } finally {
    page.off('request', countPaymentCreate)
    try {
      await page.goto(`/pos/orders/${orderId}`)
      await page.locator('article.order-detail').waitFor({ state: 'visible', timeout: 10_000 })
      cleanupCancelStatus = await cancelOrderViaUi(page, orderId)
    } catch (error) {
      console.error(
        `⚠ FE-BE-024가 만든 주문(${orderId})을 정리(취소)하지 못했습니다 — CREATED 주문과 PENDING ` +
          `결제가 남을 수 있어 수동 확인이 필요합니다: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const recovered =
    paymentCreateStatus === 201 &&
    paymentId !== '' &&
    paymentStatus === 'PENDING' &&
    recoveryStatus === 200 &&
    recoveredPaymentStatus === 'PENDING' &&
    resumeButtonVisible &&
    paymentCreateCount === 1
  const pass = recovered && cleanupCancelStatus === 200 && !transportError
  const resultCode = tossConfigError
    ? 'SKIP_PRECONDITION'
    : transportError
      ? 'ERROR_TRANSPORT'
      : pass
        ? 'PASS'
        : 'FAIL_UI'

  record({
    testCaseId: 'FE-BE-024',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode,
    expected: { requestPath: '/api/v1/payments', httpStatus: 201 },
    observed: {
      requestPath: paymentId ? `/api/v1/payments/${paymentId}` : '/api/v1/payments',
      httpStatus: recoveryStatus || paymentCreateStatus,
      finalPath: new URL(page.url()).pathname,
    },
    requestId,
    assertions: {
      pendingPaymentCreated: paymentCreateStatus === 201 && paymentStatus === 'PENDING',
      pendingPaymentRecovered: recoveryStatus === 200 && recoveredPaymentStatus === 'PENDING',
      resumeButtonVisible,
      duplicatePaymentCreateAbsent: paymentCreateCount === 1,
      cleanupCancelSucceeded: cleanupCancelStatus === 200,
    },
    browser: browserCounts(errors),
    errorClass: tossConfigError
      ? 'VITE_TOSS_CLIENT_KEY 미설정(또는 형식 오류) — 배포 Frontend 빌드 설정 확인 필요'
      : pass
        ? null
        : transportError
          ? 'UI_API_REQUEST_NOT_SENT'
          : 'UI_PENDING_PAYMENT_RECOVERY_FAILED',
  })

  if (resultCode === 'SKIP_PRECONDITION') return
  expect(
    pass,
    `FE-BE-024 실패: createStatus=${paymentCreateStatus} paymentId="${paymentId}" ` +
      `paymentStatus=${paymentStatus} recoveryStatus=${recoveryStatus} recoveredStatus=${recoveredPaymentStatus} ` +
      `resumeVisible=${resumeButtonVisible} createCount=${paymentCreateCount} cleanup=${cleanupCancelStatus} ` +
      `transportError=${transportError}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-023: 대기열 접수 화면 (Tier B, 파괴적) — RUN_DESTRUCTIVE_QUEUE_TESTS 필요
//
// api/scenarios/queue-connectivity.js의 QUEUE-003과 같은 API(POST /api/v1/queues/entry, POST
// /api/v1/queues/entry/{entryId}/cancel — EdgeClosedBoundaryFilter.java의 isApprovedQueueRoute()에
// 정규식으로 명시된 승인 Route 확인 완료)를 화면 조작으로 재현한다. QUEUE-003과 똑같이 이 Entry는
// 실 테넌트 store+businessDate Counter의 queueNumber 1개를 영구히 소비하고 취소해도 CANCELLED 행이
// 영구히 남는다 — 그래서 RUN_DESTRUCTIVE_QUEUE_TESTS=true 없이는 SKIP한다. AUTH_VALID_01을 그대로
// 쓴다(QUEUE-003과 동일 — 대기열 등록/취소에는 Role 제한이 없다, EntryQueueController.java 확인 완료).
// ---------------------------------------------------------------------------
const DESTRUCTIVE_QUEUE_FLAG = 'RUN_DESTRUCTIVE_QUEUE_TESTS'

// 영업일은 매장 Time Zone(Asia/Seoul, UTC+9)의 로컬 날짜다 — queue-connectivity.js의
// todayBusinessDate()와 정확히 같은 이유·같은 계산 방식(한국은 DST가 없어 고정 +9시간 오프셋으로
// 충분하다).
const QUEUE_STORE_UTC_OFFSET_MINUTES = 9 * 60
function todayBusinessDateKst(): string {
  return new Date(Date.now() + QUEUE_STORE_UTC_OFFSET_MINUTES * 60 * 1000).toISOString().slice(0, 10)
}

interface RegisterEntryUiResult {
  status: number
  entryId: string
  queueNumber: number | null
  transportError: string | null
}

// EntryQueueView.vue/useEntryQueue.ts를 그대로 따른다 — 영업일(유일한 input[type=date])과
// 인원수(유일한 input[type=number])를 채우고 "등록" 버튼을 누르면 register()가
// POST /api/v1/queues/entry를 호출한다. 성공하면 register()가 곧바로 load(false)를 호출해 같은
// 화면에서 목록이 갱신된다 — Route 이동이 전혀 없으므로 waitForURL은 쓰지 않는다.
async function registerEntryViaUi(page: Page, businessDate: string, partySize: number): Promise<RegisterEntryUiResult> {
  await page.goto('/pos/queues/entry')
  await page.locator('input[type="date"]').fill(businessDate)
  await page.locator('input[type="number"]').fill(String(partySize))

  let registerResponse: Response | null = null
  let transportError: string | null = null
  try {
    ;[registerResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/queues/entry',
      ),
      page.getByRole('button', { name: '등록', exact: true }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const status = registerResponse?.status() ?? 0
  let entryId = ''
  let queueNumber: number | null = null
  if (status === 201) {
    const body = await registerResponse!.json().catch(() => null)
    entryId = typeof body?.entryId === 'string' ? body.entryId : ''
    queueNumber = typeof body?.queueNumber === 'number' ? body.queueNumber : null
  }
  return { status, entryId, queueNumber, transportError }
}

// 행 매칭 정규식 버그의 근본 원인(2026-08-27 실 배포 대상 진단 스크립트로 확정 — 반박 불가능한
// 실측): 과거에는 `table tbody tr`을 hasText 정규식(`#${queueNumber}(?!\d)`)으로 필터링했다.
// Playwright의 hasText는 그 tr **전체의 concatenated text content**를 대상으로 매칭하는데,
// EntryQueueView.vue의 `<td><strong>#{{ entry.queueNumber }}</strong></td><td>{{ entry.partySize
// }}명</td>`가 같은 행 안에서 공백 없이 바로 이어 붙어, 예를 들어 queueNumber=9·partySize=2인 행의
// 실제 텍스트는 "#9" + "2명..." = "#92명..."이 된다. 그래서 `#9(?!\d)`는 "#9" 바로 뒤에 오는 문자가
// partySize의 숫자("2")라는 이유로 "#9"가 "#92"의 일부일 수 있다고 오판해 매번 매칭을 거부했다 —
// partySize는 항상 숫자로 시작하므로(인원수는 언제나 숫자), queueNumber가 몇이든 이 정규식은
// **원천적으로 절대 매칭에 성공할 수 없는 버그**였다.
//
// 진단 스크립트로 직접 확인한 결과: POST /api/v1/queues/entry로 만든 Entry는 매번 즉시 GET 응답에
// 정확히 포함돼 있었고(WAITING 상태까지 일치, rowCount도 즉시 정확), 10번 연속 확인해도 매번
// 데이터는 처음부터 끝까지 정확한데 유일하게 실패한 건 이 정규식으로 행을 "찾는" 것 자체였다. 즉
// 지금까지 이 파일에 있던 모든 대기 시간/재시도 로직(늘려온 Timeout들, 아래 8회 재시도)은 이 버그를
// 전혀 해결하지 못했고 애초에 문제 자체가 아니었다 — 순수한 정규식 매칭 버그였다.
//
// 고친 방식: 행 전체의 concatenated text가 아니라 queueNumber가 표시되는 `<strong>` 요소 하나만
// Exact 매칭 대상으로 삼는다. "#9"와 "#92"는 문자열 자체가 다르므로 exact:true 매칭에서 서로 절대
// 혼동되지 않는다 — 부정 Lookahead 정규식이 아예 필요 없다.
function findQueueRowByNumber(page: Page, queueNumber: number) {
  return page.locator('table tbody tr').filter({
    has: page.getByText(`#${queueNumber}`, { exact: true }),
  })
}

// register() 직후의 화면 반영 확인. 위 findQueueRowByNumber 주석에 적은 대로, 근본 원인이 타이밍이
// 아니라 순수한 행 매칭 정규식 버그였음이 실측으로 확정됐다 — 서버 데이터는 등록 직후 항상 즉시
// 정확했다. 그래서 register()가 이미 호출하는 즉시 1회 load(false)만으로 충분할 가능성이 높지만,
// 이 세션은 여러 사람이 동시에 같은 실 배포를 쓰고 있어 네트워크 지연·서버 부하로 반영이 아주 짧게
// 늦어질 여지는 남아 있다. 그 정도의 안전 여유만 남기고(최대 2회 재시도) 과거 두 차례에 걸쳐
// 늘렸던 8회 "새로고침" 재시도는 과도했던 부분을 걷어냈다 — 완전히 없애면 이 문제가 다시 나타났을
// 때 또 타이밍 탓으로 오진하게 만들 뿐이므로, 최소한의 여유는 의도적으로 남겨둔다. 만약 이 기본값을
// 다시 늘려야 할 상황이 생긴다면, 그 전에 반드시 실측(진단 스크립트)으로 원인이 진짜 타이밍인지부터
// 재확인할 것 — 이 파일의 행 매칭 자체는 더 이상 의심할 이유가 없다. EntryQueueView.vue의
// "새로고침" 버튼은 search() → queue.load()를 호출하며 businessDate가 이미 채워져 있고 진행 중인
// load()가 없는 한 항상 활성화 상태다.
async function waitForQueueRowViaRefresh(page: Page, queueNumber: number, maxAttempts = 2): Promise<boolean> {
  const row = findQueueRowByNumber(page, queueNumber)
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return true
    if (attempt === maxAttempts) break
    try {
      await Promise.all([
        page.waitForResponse(
          (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/v1/queues/entry',
          { timeout: 5_000 },
        ),
        page.getByRole('button', { name: '새로고침', exact: true }).click(),
      ])
    } catch {
      // 새로고침 요청/응답 자체가 실패해도(예: 버튼이 일시적으로 비활성화된 순간과 겹침) 다음
      // attempt에서 다시 시도한다 — 최종적으로 못 찾으면 루프 종료 후 false를 반환한다.
    }
  }
  return false
}

// 방금 만든 행("#{queueNumber}")을 찾아 그 행의 "취소" 버튼을 누른다. act('cancel')도 Route 이동
// 없이 같은 화면에서 load(false)로 갱신한다 — OrderDetailPanel의 "주문 취소"와 달리 이 화면은
// window.confirm()을 띄우지 않는다(EntryQueueView.vue 템플릿에 confirm 호출이 없음, 확인 완료).
// 행 매칭은 findQueueRowByNumber를 그대로 재사용한다(위 주석의 정규식 매칭 버그 설명 참고 —
// "#9"가 "#92"의 일부로 오판되던 문제는 <strong> 요소 Exact 매칭으로 이미 해결됐다). 행이 아직
// 안 보이면(registerEntryViaUi의 rowVisible 확인이 실패해 여기로 온 경우 포함)
// waitForQueueRowViaRefresh로 한 번 더 명시적 재시도한다.
async function cancelEntryRowViaUi(page: Page, entryId: string, queueNumber: number): Promise<number> {
  const row = findQueueRowByNumber(page, queueNumber)
  const visible = await waitForQueueRowViaRefresh(page, queueNumber)
  if (!visible) {
    throw new Error(`행(#${queueNumber})이 "새로고침" 재시도 후에도 화면에 보이지 않습니다`)
  }
  const [cancelResponse] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === `/api/v1/queues/entry/${entryId}/cancel`,
    ),
    row.getByRole('button', { name: '취소', exact: true }).click(),
  ])
  return cancelResponse.status()
}

test('FE-BE-023 화면에서 입장 대기 등록 → 취소', async ({ page }) => {
  test.setTimeout(60_000)
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  if (process.env[DESTRUCTIVE_QUEUE_FLAG] !== 'true') {
    record({
      testCaseId: 'FE-BE-023',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass:
        `${DESTRUCTIVE_QUEUE_FLAG}=true로 명시하지 않으면 실행하지 않음 — 등록한 Entry를 취소해도 ` +
        'store+businessDate Counter의 queueNumber 소비와 CANCELLED 행은 실 테넌트에 영구히 남는다' +
        '(QUEUE-003과 같은 이유, 위 QUEUE-003 API 시나리오 주석 참고).',
    })
    return
  }

  await loginAsAuthValid01(page, env)
  const businessDate = todayBusinessDateKst()
  const partySize = 2
  const { status, entryId, queueNumber, transportError } = await registerEntryViaUi(page, businessDate, partySize)

  // 정리(취소) 시도 여부는 서버 상태(등록 응답 201 + entryId 확보)로만 판단한다 — 아래 rowVisible
  // (순전한 UI 렌더링 확인)과는 독립시킨다. FE-BE-020이 겪은 것과 같은 이유로, 화면 확인이
  // 타이밍 문제로 실패해도 서버에는 이미 WAITING Entry가 생겼을 수 있어 정리는 반드시 시도해야 한다.
  const shouldAttemptCleanup = status === 201 && entryId !== ''
  // 실 배포 대상 진단 스크립트로 확정(위 findQueueRowByNumber 주석 참고): register() 직후 GET
  // 응답에 Entry는 항상 즉시 정확히 포함돼 있었다 — 반영이 안 되는 것처럼 보였던 진짜 원인은 앱의
  // 폴링 타이밍이 아니라 행을 찾는 정규식 자체의 매칭 버그였다. 그 버그를 고쳤으므로
  // waitForQueueRowViaRefresh의 재시도 횟수도 과도했던 8회에서 최소한의 안전 여유(최대 2회)로
  // 줄였다 — 여러 세션이 동시에 같은 실 배포를 쓰는 상황의 네트워크 지연/서버 부하 정도만 흡수하면
  // 충분하다.
  const rowVisible =
    shouldAttemptCleanup && queueNumber !== null ? await waitForQueueRowViaRefresh(page, queueNumber) : false
  const registered = status === 201 && entryId !== '' && rowVisible
  const pass = registered && !transportError

  let cleanupCancelStatus = 0
  if (shouldAttemptCleanup) {
    try {
      if (queueNumber === null) throw new Error('등록 응답 Body에서 queueNumber를 읽지 못했습니다')
      cleanupCancelStatus = await cancelEntryRowViaUi(page, entryId, queueNumber)
    } catch (uiError) {
      // 화면에서 행을 찾거나 "취소" 버튼 클릭이 실패해도, Entry가 WAITING으로 영구히 방치되지
      // 않도록 API를 직접 호출해 한 번 더 정리를 시도한다(QUEUE-003의 CSRF 실측 확인대로 대기열
      // POST는 X-XSRF-TOKEN 없이도 통과한다 — catalog-connectivity.js 주석과 대조 확인 완료).
      // page.request는 이 브라우저 Context의 로그인 Cookie를 그대로 공유한다.
      console.error(
        `⚠ FE-BE-023이 화면에서 Entry(${entryId}) 취소에 실패해 API를 직접 호출로 재시도합니다: ` +
          (uiError instanceof Error ? uiError.message : String(uiError)),
      )
      try {
        const fallbackRes = await page.request.post(`${env.apiOrigin}/api/v1/queues/entry/${entryId}/cancel`)
        cleanupCancelStatus = fallbackRes.status()
      } catch (apiError) {
        console.error(
          `⚠ FE-BE-023이 만든 Entry(${entryId})를 정리(취소)하지 못했습니다 — 실 테넌트에 WAITING ` +
            `상태로 영구히 남아있을 수 있어 수동 확인이 필요합니다: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
        )
      }

      // page.request.post()는 서버 상태만 CANCELLED로 바꿀 뿐, 이 화면이 들고 있는 Vue Reactive
      // State(useEntryQueue의 queue.entries)는 그대로 WAITING으로 남는다 — 다음에 이 화면을 보는
      // 사람이나 스냅샷이 실제 서버 상태와 다른 화면을 보고 혼선을 겪을 수 있다. EntryQueueView.vue의
      // "새로고침" 버튼(search() → queue.load() 호출, :disabled="queue.loading.value ||
      // !queue.businessDate.value" — businessDate는 registerEntryViaUi가 이미 채워둬서 비어있지
      // 않고, 이 시점엔 진행 중인 load()도 없어 버튼이 활성화 상태다)을 눌러 화면 State를 서버와
      // 맞춘다. 이미 검증(rowVisible/pass)이 끝난 뒤의 정리 단계라 여기서 실패해도 테스트 결과에는
      // 영향을 주지 않는 best-effort로 처리한다.
      if (cleanupCancelStatus === 200) {
        try {
          await Promise.all([
            page.waitForResponse(
              (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/v1/queues/entry',
            ),
            page.getByRole('button', { name: '새로고침', exact: true }).click(),
          ])
        } catch (refreshError) {
          console.error(
            `⚠ FE-BE-023이 Fallback 취소 이후 화면 새로고침에 실패했습니다(서버 상태는 이미 정상 ` +
              `취소됨): ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
          )
        }
      }
    }
  }

  record({
    testCaseId: 'FE-BE-023',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_VALID_01',
    resultCode: transportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_UI',
    expected: { requestPath: '/api/v1/queues/entry', httpStatus: 201 },
    observed: { requestPath: '/api/v1/queues/entry', httpStatus: status },
    assertions: {
      entryRegistered: status === 201,
      entryRowVisible: rowVisible,
      cleanupCancelSucceeded: shouldAttemptCleanup && cleanupCancelStatus === 200,
    },
    browser: browserCounts(errors),
    errorClass: pass ? null : transportError ? 'UI_API_REQUEST_NOT_SENT' : 'UI_QUEUE_ENTRY_REGISTER_FAILED',
  })

  expect(
    pass,
    `FE-BE-023 실패: status=${status} entryId="${entryId}" rowVisible=${rowVisible} transportError=${transportError}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-025: 카탈로그(분류·상품) 등록/수정 화면 (Tier B, 파괴적) — RUN_DESTRUCTIVE_CATALOG_TESTS 필요
//
// api/scenarios/catalog-connectivity.js의 CATALOG-004~006과 같은 API를 화면 조작으로 재현한다.
// Category·Product 둘 다 DELETE Endpoint가 없어(CatalogCategoryController.java/
// CatalogProductController.java 확인 완료) 생성한 자원은 영구히 남는다 — 그래서 정리는
// "이용 중지"/"판매 중지" 토글로 active:false 전환까지만 시도한다(실제 삭제 아님). Category·Product
// 생성/수정은 CatalogService.requireCatalogManager() → ActorRole.canManageCatalog()를 거쳐 OWNER·
// MANAGER만 허용하고(CatalogManagementView.vue의 canManage와 정확히 같은 조건), CATALOG-004~006과
// 같은 이유로 AUTH_VALID_01이 아니라 AUTH_ROLE_OWNER_01(합성 테넌트 e2e-auth-active)로 로그인한다 —
// AUTH_VALID_01의 테넌트(sample-store)는 실 데모 테넌트라 영구 Catalog 데이터를 남기고 싶지 않다.
// PATCH 요청의 If-Match(낙관적 잠금) 헤더는 Doro-ERP-Front/src/api/catalog.ts의 updateCategory()/
// updateProduct()가 이미 자동으로 붙인다(ifMatch() 헬퍼, version을 그대로 따옴표로 감싸 전송) —
// 화면을 그대로 조작하는 이 테스트는 별도로 헤더를 다룰 필요가 없다.
// ---------------------------------------------------------------------------
const DESTRUCTIVE_CATALOG_FLAG = 'RUN_DESTRUCTIVE_CATALOG_TESTS'

interface CreateCategoryUiResult {
  status: number
  categoryId: string
  transportError: string | null
}

// CatalogManagementView.vue/useCatalogManagement.ts를 그대로 따른다 — "분류 등록" 버튼(canManage일
// 때만 노출)을 누르면 #category-editor 패널이 열리고, 분류명(#category-name)·표시 순서
// (#category-order)를 채운 뒤 그 패널 안의 "저장" 버튼을 누르면 saveCategory()가
// POST /api/v1/catalog/categories를 호출한다. 성공하면 목록을 다시 불러오고 editor를 자동으로
// 닫는다 — Route 이동이 없으므로 waitForURL은 쓰지 않는다.
async function createCategoryViaUi(page: Page, name: string): Promise<CreateCategoryUiResult> {
  await page.getByRole('button', { name: '분류 등록' }).click()
  await page.locator('#category-name').fill(name)
  await page.locator('#category-order').fill('1')

  let response: Response | null = null
  let transportError: string | null = null
  try {
    ;[response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/catalog/categories',
      ),
      page.locator('#category-editor').getByRole('button', { name: '저장' }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const status = response?.status() ?? 0
  let categoryId = ''
  if (status === 201) {
    const body = await response!.json().catch(() => null)
    categoryId = typeof body?.categoryId === 'string' ? body.categoryId : ''
  }
  return { status, categoryId, transportError }
}

interface CreateProductUiResult {
  status: number
  productId: string
  transportError: string | null
}

// "상품 등록" 버튼은 canManage && selectedCategoryId일 때만 노출된다 — 호출부가 새로 만든 분류를
// 미리 선택해둔 뒤(.category-select 클릭) 이 함수를 부른다. #product-editor 패널의 메뉴 분류
// select에서 방금 만든 분류를 명시적으로 고르고, 상품명·가격을 채운 뒤 "저장"을 누르면
// saveProduct()가 POST /api/v1/catalog/products를 호출한다.
async function createProductViaUi(page: Page, categoryName: string, name: string): Promise<CreateProductUiResult> {
  await page.getByRole('button', { name: '상품 등록' }).click()
  await page.locator('#product-editor select').selectOption({ label: categoryName })
  await page.getByLabel('상품명').fill(name)
  await page.getByLabel('가격').fill('1000')

  let response: Response | null = null
  let transportError: string | null = null
  try {
    ;[response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/catalog/products',
      ),
      page.locator('#product-editor').getByRole('button', { name: '저장' }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const status = response?.status() ?? 0
  let productId = ''
  if (status === 201) {
    const body = await response!.json().catch(() => null)
    productId = typeof body?.productId === 'string' ? body.productId : ''
  }
  return { status, productId, transportError }
}

interface UpdateCategoryUiResult {
  status: number
  name: string
  transportError: string | null
}

async function updateCategoryViaUi(
  page: Page,
  categoryId: string,
  currentName: string,
  nextName: string,
): Promise<UpdateCategoryUiResult> {
  let response: Response | null = null
  let transportError: string | null = null
  try {
    const row = page.locator('.category-list li').filter({ hasText: currentName })
    await row.getByRole('button', { name: '수정', exact: true }).click()
    await page.locator('#category-name').fill(nextName)
    await page.locator('#category-order').fill('2')
    ;[response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          new URL(res.url()).pathname === `/api/v1/catalog/categories/${categoryId}`,
      ),
      page.locator('#category-editor').getByRole('button', { name: '저장' }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const status = response?.status() ?? 0
  const body = response ? await response.json().catch(() => null) : null
  const name = typeof body?.name === 'string' ? body.name : ''
  return { status, name, transportError }
}

interface UpdateProductUiResult {
  status: number
  name: string
  price: string
  transportError: string | null
}

async function updateProductViaUi(
  page: Page,
  productId: string,
  currentName: string,
  nextName: string,
): Promise<UpdateProductUiResult> {
  let response: Response | null = null
  let transportError: string | null = null
  try {
    const row = page.locator('.product-panel table tbody tr').filter({ hasText: currentName })
    await row.getByRole('button', { name: '수정', exact: true }).click()
    await page.getByLabel('상품명').fill(nextName)
    await page.getByLabel('설명').fill('FE-BE-025 수정 확인')
    await page.getByLabel('가격').fill('1200')
    await page.getByLabel('표시 순서').fill('2')
    ;[response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          new URL(res.url()).pathname === `/api/v1/catalog/products/${productId}`,
      ),
      page.locator('#product-editor').getByRole('button', { name: '저장' }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const status = response?.status() ?? 0
  const body = response ? await response.json().catch(() => null) : null
  const name = typeof body?.name === 'string' ? body.name : ''
  const price = typeof body?.price === 'number' || typeof body?.price === 'string' ? String(body.price) : ''
  return { status, name, price, transportError }
}

interface SoldOutUiResult {
  status: number
  soldOut: boolean | null
  transportError: string | null
}

async function changeSoldOutViaUi(
  page: Page,
  productId: string,
  productName: string,
  nextSoldOut: boolean,
): Promise<SoldOutUiResult> {
  let response: Response | null = null
  let transportError: string | null = null
  try {
    const row = page.locator('.product-panel table tbody tr').filter({ hasText: productName })
    const buttonName = nextSoldOut ? '품절 처리' : '품절 해제'
    ;[response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          new URL(res.url()).pathname === `/api/v1/catalog/products/${productId}/sold-out`,
      ),
      row.getByRole('button', { name: buttonName, exact: true }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const status = response?.status() ?? 0
  const body = response ? await response.json().catch(() => null) : null
  const soldOut = typeof body?.soldOut === 'boolean' ? body.soldOut : null
  return { status, soldOut, transportError }
}

interface DeactivateUiResult {
  status: number
  active: boolean | null
}

// "이용 중지" 토글(toggleCategory)은 PATCH /api/v1/catalog/categories/{id}에 {active:false}만
// 보낸다 — CatalogService.updateCategory()가 부분 업데이트라 이 필드만 바뀐다(위 파일 상단 주석
// 확인 완료).
async function deactivateCategoryViaUi(page: Page, categoryId: string, categoryName: string): Promise<DeactivateUiResult> {
  const row = page.locator('.category-list li').filter({ hasText: categoryName })
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === `/api/v1/catalog/categories/${categoryId}`,
    ),
    row.getByRole('button', { name: '이용 중지' }).click(),
  ])
  const body = await response.json().catch(() => null)
  return { status: response.status(), active: typeof body?.active === 'boolean' ? body.active : null }
}

// "판매 중지" 토글(toggleProductActive)은 PATCH /api/v1/catalog/products/{id}에 {active:false}만
// 보낸다 — "품절 처리"(toggleSoldOut, PATCH .../sold-out)와는 다른 필드·다른 Endpoint다(위 파일
// 상단 주석에서 이 테스트가 다루는 대상을 "판매 중지"로 명시).
async function deactivateProductViaUi(page: Page, productId: string, productName: string): Promise<DeactivateUiResult> {
  const row = page.locator('.product-panel table tbody tr').filter({ hasText: productName })
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === `/api/v1/catalog/products/${productId}`,
    ),
    row.getByRole('button', { name: '판매 중지' }).click(),
  ])
  const body = await response.json().catch(() => null)
  return { status: response.status(), active: typeof body?.active === 'boolean' ? body.active : null }
}

test('FE-BE-025 화면에서 분류·상품 등록/수정 → 품절 왕복 → 비활성화', async ({ page }) => {
  test.setTimeout(60_000)
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  if (process.env[DESTRUCTIVE_CATALOG_FLAG] !== 'true') {
    record({
      testCaseId: 'FE-BE-025',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass:
        `${DESTRUCTIVE_CATALOG_FLAG}=true로 명시하지 않으면 실행하지 않음 — Category·Product는 DELETE ` +
        'Endpoint가 없어 생성하면 영구히 남는다(CATALOG-004~006과 같은 이유, 위 CATALOG-004~006 API 시나리오 주석 참고).',
    })
    return
  }

  const account = env.staticAccounts.roleOwner
  if (!account) {
    record({
      testCaseId: 'FE-BE-025',
      startedAt,
      durationMs: 0,
      accountAlias: 'AUTH_ROLE_OWNER_01',
      resultCode: 'SKIP_PRECONDITION',
      errorClass: 'AUTH_ROLE_OWNER_01 정적 계정 없음 — 합성 테넌트(e2e-auth-active) Fixture 준비 불가',
    })
    return
  }

  await page.goto('/pos/login')
  await fillLoginForm(page, account.tenantCode, account.loginId, account.password)
  const loginResponse = await submitAndWaitLogin(page)
  if (loginResponse.status() !== 200) {
    record({
      testCaseId: 'FE-BE-025',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_ROLE_OWNER_01',
      resultCode: 'ERROR_TRANSPORT',
      errorClass: `사전 로그인 실패 (status=${loginResponse.status()}) — FE-BE-025 전제조건 불충족`,
    })
    expect(false, `FE-BE-025 실패: 사전 로그인 실패 (status=${loginResponse.status()})`).toBe(true)
    return
  }
  await page.waitForURL('**/pos/orders', { timeout: 10_000 })

  await page.goto('/pos/catalog')
  await page.getByRole('button', { name: '분류 등록' }).waitFor({ state: 'visible', timeout: 10_000 })

  const suffix = randomToken().slice(0, 8)
  const categoryName = `E2E-FEBE025-CAT-${suffix}`
  const productName = `E2E-FEBE025-PROD-${suffix}`
  const updatedCategoryName = `${categoryName}-UPDATED`
  const updatedProductName = `${productName}-UPDATED`

  const categoryResult = await createCategoryViaUi(page, categoryName)
  const categoryCreated = categoryResult.status === 201 && categoryResult.categoryId !== ''

  let categoryListed = false
  let productResult: CreateProductUiResult = { status: 0, productId: '', transportError: null }
  let productCreated = false
  let productListed = false
  let categoryUpdate: UpdateCategoryUiResult = { status: 0, name: '', transportError: null }
  let categoryUpdated = false
  let productUpdate: UpdateProductUiResult = { status: 0, name: '', price: '', transportError: null }
  let productUpdated = false
  let soldOutOn: SoldOutUiResult = { status: 0, soldOut: null, transportError: null }
  let soldOutOff: SoldOutUiResult = { status: 0, soldOut: null, transportError: null }
  let currentCategoryName = categoryName
  let currentProductName = productName
  let productDeactivate: DeactivateUiResult = { status: 0, active: null }
  let categoryDeactivate: DeactivateUiResult = { status: 0, active: null }

  if (categoryCreated) {
    try {
      categoryListed = await page
        .locator('.category-list li')
        .filter({ hasText: categoryName })
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false)

      // load() 이후 selectedCategoryId가 기존 분류(테넌트에 이미 있을 수 있는 CATALOG-004~006
      // 잔여물 포함)로 자동 재설정될 수 있어, 방금 만든 분류를 명시적으로 선택해야 "상품 등록"
      // 버튼이 이 분류 아래에서 열린다.
      await page.locator('.category-list li').filter({ hasText: categoryName }).locator('.category-select').click()

      productResult = await createProductViaUi(page, categoryName, productName)
      productCreated = productResult.status === 201 && productResult.productId !== ''

      if (productCreated) {
        productListed = await page
          .locator('.product-panel table tbody tr')
          .filter({ hasText: productName })
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false)

        categoryUpdate = await updateCategoryViaUi(
          page,
          categoryResult.categoryId,
          categoryName,
          updatedCategoryName,
        )
        categoryUpdated = categoryUpdate.status === 200 && categoryUpdate.name === updatedCategoryName
        if (categoryUpdated) currentCategoryName = updatedCategoryName

        const updatedCategoryListed = categoryUpdated
          ? await page
              .locator('.category-list li')
              .filter({ hasText: updatedCategoryName })
              .waitFor({ state: 'visible', timeout: 5_000 })
              .then(() => true)
              .catch(() => false)
          : false
        categoryUpdated = categoryUpdated && updatedCategoryListed

        // Category 수정 후 목록을 다시 읽는 과정에서 선택 상태가 바뀔 수 있으므로 현재 이름으로
        // 다시 선택한 뒤 Product 수정·품절 왕복을 이어간다.
        await page
          .locator('.category-list li')
          .filter({ hasText: currentCategoryName })
          .locator('.category-select')
          .click()

        productUpdate = await updateProductViaUi(
          page,
          productResult.productId,
          productName,
          updatedProductName,
        )
        productUpdated =
          productUpdate.status === 200 &&
          productUpdate.name === updatedProductName &&
          productUpdate.price === '1200'
        if (productUpdate.status === 200 && productUpdate.name) currentProductName = productUpdate.name

        const updatedProductListed = productUpdated
          ? await page
              .locator('.product-panel table tbody tr')
              .filter({ hasText: updatedProductName })
              .waitFor({ state: 'visible', timeout: 5_000 })
              .then(() => true)
              .catch(() => false)
          : false
        productUpdated = productUpdated && updatedProductListed

        if (productUpdated) {
          soldOutOn = await changeSoldOutViaUi(
            page,
            productResult.productId,
            currentProductName,
            true,
          )
          soldOutOff = await changeSoldOutViaUi(
            page,
            productResult.productId,
            currentProductName,
            false,
          )
        }
      }
    } finally {
      // 정리(cleanup) 시도 여부는 서버 상태(생성 응답 201 + id 확보)로만 판단한다 — 위
      // categoryListed/productListed(순전한 UI 렌더링 확인)와는 독립시킨다. DELETE Endpoint가
      // 없으므로 정리는 active:false 전환까지만 가능하다(실제 삭제 아님) — QUEUE-003/
      // CATALOG-004~006과 같은 "정리는 되지만 이력은 영구 잔존" 패턴.
      if (productCreated) {
        try {
          productDeactivate = await deactivateProductViaUi(
            page,
            productResult.productId,
            currentProductName,
          )
        } catch (error) {
          console.error(
            `⚠ FE-BE-025가 만든 상품(${productResult.productId})을 정리(판매 중지)하지 못했습니다 — ` +
              `실 테넌트에 판매 중 상태로 영구히 남아있을 수 있어 수동 확인이 필요합니다: ` +
              (error instanceof Error ? error.message : String(error)),
          )
        }
      }
      try {
        categoryDeactivate = await deactivateCategoryViaUi(
          page,
          categoryResult.categoryId,
          currentCategoryName,
        )
      } catch (error) {
        console.error(
          `⚠ FE-BE-025가 만든 분류(${categoryResult.categoryId})를 정리(이용 중지)하지 못했습니다 — ` +
            `실 테넌트에 운영 중 상태로 영구히 남아있을 수 있어 수동 확인이 필요합니다: ` +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    }
  }

  const productDeactivatedOk = productDeactivate.status === 200 && productDeactivate.active === false
  const categoryDeactivatedOk = categoryDeactivate.status === 200 && categoryDeactivate.active === false
  const soldOutRoundTripOk =
    soldOutOn.status === 200 &&
    soldOutOn.soldOut === true &&
    soldOutOff.status === 200 &&
    soldOutOff.soldOut === false
  const transportError =
    categoryResult.transportError ??
    productResult.transportError ??
    categoryUpdate.transportError ??
    productUpdate.transportError ??
    soldOutOn.transportError ??
    soldOutOff.transportError
  const pass =
    categoryCreated &&
    categoryListed &&
    productCreated &&
    productListed &&
    categoryUpdated &&
    productUpdated &&
    soldOutRoundTripOk &&
    productDeactivatedOk &&
    categoryDeactivatedOk &&
    !transportError

  record({
    testCaseId: 'FE-BE-025',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: 'AUTH_ROLE_OWNER_01',
    resultCode: transportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_UI',
    expected: { requestPath: '/api/v1/catalog/categories', httpStatus: 201 },
    observed: { requestPath: '/api/v1/catalog/categories', httpStatus: categoryResult.status },
    assertions: {
      categoryCreated,
      categoryListed,
      productCreated,
      productListed,
      categoryUpdated,
      productUpdated,
      soldOutRoundTripOk,
      productDeactivatedOk,
      categoryDeactivatedOk,
    },
    browser: browserCounts(errors),
    errorClass: pass
      ? null
      : transportError
        ? 'UI_API_REQUEST_NOT_SENT'
        : 'UI_CATALOG_CREATE_UPDATE_SOLD_OUT_OR_DEACTIVATE_FAILED',
  })

  expect(
    pass,
    `FE-BE-025 실패: categoryStatus=${categoryResult.status} categoryId="${categoryResult.categoryId}" ` +
      `productStatus=${productResult.status} productId="${productResult.productId}" ` +
      `categoryUpdated=${categoryUpdated} productUpdated=${productUpdated} soldOutRoundTripOk=${soldOutRoundTripOk} ` +
      `productDeactivatedOk=${productDeactivatedOk} categoryDeactivatedOk=${categoryDeactivatedOk}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// FE-BE-026/027: 운영·보안 이력 화면 (Tier A, 비파괴)
//
// 두 화면은 OWNER/MANAGER만 접근할 수 있다. AUTH_VALID_01과 같은 물리 계정일 수 있는 OWNER보다
// 별도 Rate Limit Bucket을 쓰는 MANAGER를 우선 선택한다. 결과가 비어 있는 것은 정상 계약이므로
// API 200 + 정상 EmptyState도 PASS로 인정하고, 운영 변경 내역이 있으면 상세 Drawer까지 검증한다.
// ---------------------------------------------------------------------------
interface HistoryAccount {
  account: RoleAccount
  alias: 'AUTH_ROLE_MANAGER_01' | 'AUTH_ROLE_OWNER_01'
}

function historyAccount(): HistoryAccount | null {
  if (env.staticAccounts.roleManager) {
    return { account: env.staticAccounts.roleManager, alias: 'AUTH_ROLE_MANAGER_01' }
  }
  if (env.staticAccounts.roleOwner) {
    return { account: env.staticAccounts.roleOwner, alias: 'AUTH_ROLE_OWNER_01' }
  }
  return null
}

async function loginHistoryAccount(page: Page, fixture: HistoryAccount): Promise<Response> {
  await page.goto('/pos/login')
  await fillLoginForm(
    page,
    fixture.account.tenantCode,
    fixture.account.loginId,
    fixture.account.password,
  )
  const response = await submitAndWaitLogin(page)
  if (response.status() === 200) {
    await page.waitForURL('**/pos/orders', { timeout: 10_000 })
  }
  return response
}

test('FE-BE-026 운영 변경 내역 목록과 상세 조회', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const fixture = historyAccount()

  if (!fixture) {
    record({
      testCaseId: 'FE-BE-026',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass:
        'AUTH_ROLE_MANAGER_01/AUTH_ROLE_OWNER_01 정적 계정이 모두 없음 — 운영 변경 내역 접근 전제 불충족',
    })
    return
  }

  const loginResponse = await loginHistoryAccount(page, fixture)
  if (loginResponse.status() !== 200) {
    record({
      testCaseId: 'FE-BE-026',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: fixture.alias,
      resultCode: 'ERROR_TRANSPORT',
      expected: { requestPath: '/api/v1/auth/login', httpStatus: 200 },
      observed: { requestPath: '/api/v1/auth/login', httpStatus: loginResponse.status() },
      assertions: { loginSucceeded: false },
      browser: browserCounts(errors),
      errorClass: 'UI_RESPONSE_MAPPING_FAILED',
    })
    expect(false, `FE-BE-026 실패: 사전 로그인 status=${loginResponse.status()}`).toBe(true)
    return
  }

  let auditResponse: Response | null = null
  let detailResponse: Response | null = null
  let transportError: string | null = null
  try {
    ;[auditResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/v1/audits',
      ),
      page.goto('/pos/history'),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const auditStatus = auditResponse?.status() ?? 0
  const screenVisible = await page
    .locator('section.audit-page')
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  const contentRendered = screenVisible
    ? await expect
        .poll(
          async () =>
            (await page.locator('section.audit-page tbody tr').count()) > 0 ||
            (await page.getByText('운영 변경 내역이 없습니다', { exact: true }).isVisible().catch(() => false)),
          { timeout: 10_000 },
        )
        .toBe(true)
        .then(() => true)
        .catch(() => false)
    : false
  const rowCount = contentRendered ? await page.locator('section.audit-page tbody tr').count() : 0

  let detailVerified = rowCount === 0
  if (rowCount > 0) {
    try {
      ;[detailResponse] = await Promise.all([
        page.waitForResponse((res) => {
          if (res.request().method() !== 'GET') return false
          return /^\/api\/v1\/audits\/[^/]+$/.test(new URL(res.url()).pathname)
        }),
        page.getByRole('button', { name: '변경 기록 상세 보기' }).first().click(),
      ])
      detailVerified =
        detailResponse.status() === 200 &&
        (await page
          .getByRole('dialog', { name: '변경 기록 상세' })
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false))
    } catch (error) {
      transportError = error instanceof Error ? error.message : String(error)
      detailVerified = false
    }
  }

  const pass = auditStatus === 200 && screenVisible && contentRendered && detailVerified && !transportError
  record({
    testCaseId: 'FE-BE-026',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: fixture.alias,
    resultCode: transportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_UI',
    expected: { requestPath: '/api/v1/audits', httpStatus: 200, finalPath: '/pos/history' },
    observed: {
      requestPath: detailResponse ? new URL(detailResponse.url()).pathname : '/api/v1/audits',
      httpStatus: detailResponse?.status() ?? auditStatus,
      finalPath: new URL(page.url()).pathname,
    },
    requestId: detailResponse?.headers()['x-request-id'] ?? auditResponse?.headers()['x-request-id'] ?? '',
    assertions: {
      auditQuerySucceeded: auditStatus === 200,
      auditScreenVisible: screenVisible,
      listOrEmptyStateRendered: contentRendered,
      detailVerifiedWhenPresent: detailVerified,
    },
    browser: browserCounts(errors),
    errorClass: pass ? null : transportError ? 'UI_API_REQUEST_NOT_SENT' : 'UI_AUDIT_HISTORY_FAILED',
  })

  expect(
    pass,
    `FE-BE-026 실패: auditStatus=${auditStatus} screenVisible=${screenVisible} ` +
      `contentRendered=${contentRendered} rowCount=${rowCount} detailVerified=${detailVerified} ` +
      `transportError=${transportError}`,
  ).toBe(true)
})

test('FE-BE-027 로그인·보안 기록 조회', async ({ page }) => {
  const errors = trackBrowserErrors(page)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const fixture = historyAccount()

  if (!fixture) {
    record({
      testCaseId: 'FE-BE-027',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass:
        'AUTH_ROLE_MANAGER_01/AUTH_ROLE_OWNER_01 정적 계정이 모두 없음 — 보안 이력 접근 전제 불충족',
    })
    return
  }

  const loginResponse = await loginHistoryAccount(page, fixture)
  if (loginResponse.status() !== 200) {
    record({
      testCaseId: 'FE-BE-027',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: fixture.alias,
      resultCode: 'ERROR_TRANSPORT',
      expected: { requestPath: '/api/v1/auth/login', httpStatus: 200 },
      observed: { requestPath: '/api/v1/auth/login', httpStatus: loginResponse.status() },
      assertions: { loginSucceeded: false },
      browser: browserCounts(errors),
      errorClass: 'UI_RESPONSE_MAPPING_FAILED',
    })
    expect(false, `FE-BE-027 실패: 사전 로그인 status=${loginResponse.status()}`).toBe(true)
    return
  }

  await page.goto('/pos/history')
  await page.getByRole('button', { name: '운영 변경 내역' }).waitFor({ state: 'visible', timeout: 10_000 })

  let securityResponse: Response | null = null
  let transportError: string | null = null
  try {
    ;[securityResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'GET' &&
          new URL(res.url()).pathname === '/api/v1/security-history',
      ),
      page.getByRole('button', { name: '로그인·보안 기록' }).click(),
    ])
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error)
  }

  const securityStatus = securityResponse?.status() ?? 0
  const screenVisible = await page
    .locator('section.security')
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  const contentRendered = screenVisible
    ? await expect
        .poll(
          async () =>
            (await page.locator('section.security tbody tr').count()) > 0 ||
            (await page.getByText('로그인·보안 기록이 없습니다', { exact: true }).isVisible().catch(() => false)),
          { timeout: 10_000 },
        )
        .toBe(true)
        .then(() => true)
        .catch(() => false)
    : false
  const pass = securityStatus === 200 && screenVisible && contentRendered && !transportError

  record({
    testCaseId: 'FE-BE-027',
    startedAt,
    durationMs: Date.now() - t0,
    accountAlias: fixture.alias,
    resultCode: transportError ? 'ERROR_TRANSPORT' : pass ? 'PASS' : 'FAIL_UI',
    expected: { requestPath: '/api/v1/security-history', httpStatus: 200, finalPath: '/pos/history' },
    observed: {
      requestPath: '/api/v1/security-history',
      httpStatus: securityStatus,
      finalPath: new URL(page.url()).pathname,
    },
    requestId: securityResponse?.headers()['x-request-id'] ?? '',
    assertions: {
      securityHistoryQuerySucceeded: securityStatus === 200,
      securityHistoryScreenVisible: screenVisible,
      listOrEmptyStateRendered: contentRendered,
    },
    browser: browserCounts(errors),
    errorClass: pass ? null : transportError ? 'UI_API_REQUEST_NOT_SENT' : 'UI_SECURITY_HISTORY_FAILED',
  })

  expect(
    pass,
    `FE-BE-027 실패: securityStatus=${securityStatus} screenVisible=${screenVisible} ` +
      `contentRendered=${contentRendered} transportError=${transportError}`,
  ).toBe(true)
})
