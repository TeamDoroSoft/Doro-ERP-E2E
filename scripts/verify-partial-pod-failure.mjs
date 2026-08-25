#!/usr/bin/env node
// OPS-005(배포 Frontend–Backend 종단 검증.md §6 "Infra 전용 시나리오" — "일부 Pod/Target 비정상 →
// Readiness로 제외되고 정상 Target 응답과 Session 계약이 일관됨")를 실 배포 EKS에서 검증한다.
//
// Doro-ERP-GitOps deploy/base/store-access-api/{deployment,availability,service}.yaml 기준으로
// store-access-api는 HPA minReplicas:2 — 즉 평소에도 Pod가 최소 2개다. 그중 1개를 실제로
// delete해서 "Pod 하나가 비정상(사라짐)" 상태를 만들고, 다음을 확인한다:
//   1) 그 Pod의 IP가 Service EndpointSlice의 Ready 주소 목록에서 실제로 빠지는가
//   2) 빠져 있는 동안 나머지 1개 Pod만으로 로그인 요청이 계속 정상(401) 처리되는가
//   3) 실 계정으로 로그인 → 보호 API 왕복까지 정상인가 (Session은 Redis 공유 저장소라 어느
//      Pod가 처리하든 일관돼야 한다 — 이게 "Session 계약 일관성")
//   4) ReplicaSet이 대체 Pod를 새로 띄워 다시 정상 Replica 수로 복구되는가
//
// `kubectl rollout restart`는 쓰지 않는다 — Deployment의 RollingUpdate 전략이
// maxUnavailable:0/maxSurge:1이라 항상 최소 2개 Ready를 유지한 채로 교체되므로, 이 시나리오가
// 요구하는 "일부 Pod가 실제로 빠진 상태"가 재현되지 않는다. 그래서 `kubectl delete pod`로
// 직접 하나를 제거해야 한다.
//
// store-access-api 컨테이너는 readOnlyRootFilesystem + capabilities drop ALL + non-root라
// Pod 안에 exec해서 네트워크를 끊는 방식은 애초에 불가능하고, 앱에도 Readiness를 외부에서
// 강제로 내릴 수 있는 커스텀 Endpoint가 없다(edge-api/store-access-api 둘 다 커스텀
// HealthIndicator 없음, Readiness = App Context Up 여부뿐) — 그래서 Pod delete가 유일하게
// 안전하고 검증 가능한 방법이다.
//
// 주의: 이 스크립트는 사설(Private) EKS API Endpoint에 도달 가능하고 대상 namespace에서
// pods/delete, pods/list, endpointslices/list 권한이 있는 kubectl context가 필요하다. 이
// 스크립트를 작성한 환경에서는 그런 접근이 없어서(EKS Access Entry 미등록 — 별도 확인·승인
// 필요) 실제로 실행해 검증하지 못했다 — 최초 실행 전 결과를 반드시 직접 확인할 것.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const K8S_NAMESPACE = process.env.DORO_K8S_NAMESPACE ?? 'doro-alpha'
const K8S_DEPLOYMENT = process.env.DORO_K8S_STORE_ACCESS_DEPLOYMENT ?? 'store-access-api'
const K8S_SERVICE = process.env.DORO_K8S_STORE_ACCESS_SERVICE ?? 'store-access-api'
const K8S_LABEL_SELECTOR = process.env.DORO_K8S_STORE_ACCESS_LABEL_SELECTOR ?? 'app.kubernetes.io/name=store-access-api'
const EDGE_ORIGIN = (process.env.DORO_API_ORIGIN ?? 'https://doro.minseok.click').replace(/\/$/, '')
// FE-BE-003/SESS-001이 로그인 직후 실제로 호출하는 것과 같은 비파괴 조회 API — Role 제한 없음
// (api/scenarios/session-flow.js 주석 참고, EdgeOrderController.java/OrderController.java 확인 완료).
const PROTECTED_PATH = '/api/v1/orders'

if (!process.argv.includes('--confirm')) {
  console.error(
    `OPS-005는 실제로 ${K8S_NAMESPACE}/${K8S_DEPLOYMENT}의 Pod 1개를 delete합니다 ` +
      '(대체 Pod가 Readiness를 통과할 때까지 재기동 시간이 걸립니다). ' +
      '승인된 점검 시간이 맞으면 --confirm을 붙여 다시 실행하세요.',
  )
  process.exit(2)
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    console.error(`${name} 환경변수가 없습니다 — Session 계약 확인(3단계)에 AUTH_VALID_01 실 계정이 필요합니다.`)
    process.exit(2)
  }
  return value
}

const account = {
  tenantCode: requireEnv('DORO_AUTH_VALID_01_TENANT_CODE'),
  loginId: requireEnv('DORO_AUTH_VALID_01_LOGIN_ID'),
  password: requireEnv('DORO_AUTH_VALID_01_PASSWORD'),
}

function kubectl(args) {
  return execFileSync('kubectl', args, { encoding: 'utf8' }).trim()
}

function kubectlJson(args) {
  return JSON.parse(kubectl([...args, '-o', 'json']))
}

function kubectlReachable() {
  try {
    kubectl(['get', 'deployment', K8S_DEPLOYMENT, '-n', K8S_NAMESPACE, '-o', 'name'])
    return true
  } catch {
    return false
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function loginProbe() {
  try {
    const res = await fetchWithTimeout(
      `${EDGE_ORIGIN}/api/v1/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantCode: 'ops-005-probe', loginId: 'probe', password: 'probe' }),
      },
      5000,
    )
    return { status: res.status }
  } catch (error) {
    return { status: 0, transportError: error instanceof Error ? error.message : String(error) }
  }
}

function parseCookies(res) {
  const jar = {}
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const idx = pair.indexOf('=')
    jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return jar
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

// 실 계정으로 로그인 → 보호 API 왕복까지 정상인지 확인한다. 어느 Pod가 요청을 처리하든
// Session은 Redis 공유 저장소에 있으니 결과가 일관돼야 한다 — 이 왕복이 실패한다면 Pod별로
// Session 처리가 어긋난다는 뜻이라 "Session 계약 일관성" 위반 증거가 된다.
async function checkSessionRoundTrip() {
  try {
    const loginRes = await fetchWithTimeout(
      `${EDGE_ORIGIN}/api/v1/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(account),
      },
      8000,
    )
    if (loginRes.status !== 200) return { ok: false, step: 'login', status: loginRes.status }
    const jar = parseCookies(loginRes)

    const protectedRes = await fetchWithTimeout(
      `${EDGE_ORIGIN}${PROTECTED_PATH}`,
      { headers: { Cookie: cookieHeader(jar) } },
      8000,
    )
    return { ok: protectedRes.status === 200, step: 'protected-api', status: protectedRes.status }
  } catch (error) {
    return { ok: false, step: 'transport', transportError: error instanceof Error ? error.message : String(error) }
  }
}

function getReadyPods() {
  const pods = kubectlJson(['get', 'pods', '-n', K8S_NAMESPACE, '-l', K8S_LABEL_SELECTOR]).items
  return pods.filter((p) => (p.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'))
}

// 이 Service는 label-selector 기반 단순 ClusterIP라 자동 생성된 기본 EndpointSlice 하나에
// 전체 Ready 주소가 들어 있다고 가정한다(Doro-ERP-GitOps deploy/base/store-access-api/service.yaml 확인).
function getReadyEndpointIps() {
  const slices = kubectlJson([
    'get', 'endpointslices', '-n', K8S_NAMESPACE,
    '-l', `kubernetes.io/service-name=${K8S_SERVICE}`,
  ]).items
  const ips = new Set()
  for (const slice of slices) {
    for (const ep of slice.endpoints ?? []) {
      if (ep.conditions?.ready) {
        for (const addr of ep.addresses ?? []) ips.add(addr)
      }
    }
  }
  return ips
}

async function waitUntil(predicate, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

async function main() {
  console.log(`[OPS-005] 대상: ${K8S_NAMESPACE}/${K8S_DEPLOYMENT} (Service: ${K8S_SERVICE})`)

  if (!kubectlReachable()) {
    throw new Error(
      `kubectl로 ${K8S_NAMESPACE}/${K8S_DEPLOYMENT}에 접근할 수 없습니다 — EKS 사설 API Endpoint에 도달 가능한 ` +
        'kubectl context와 해당 namespace에 대한 EKS Access Entry(RBAC)가 필요합니다.',
    )
  }

  const readyPods = getReadyPods()
  if (readyPods.length < 2) {
    throw new Error(`Ready Pod가 ${readyPods.length}개뿐입니다 — 최소 2개(HPA minReplicas)가 정상인 상태에서 시작해야 합니다.`)
  }
  const target = readyPods[0]
  const targetName = target.metadata.name
  const targetIp = target.status.podIP
  const originalReadyCount = readyPods.length
  console.log(`대상 Pod 선택: ${targetName} (IP: ${targetIp}), 시작 시점 Ready Pod 수: ${originalReadyCount}`)

  console.log('사전 확인: 정상 상태에서 로그인 요청이 401로 응답하는지, 대상 Pod IP가 Endpoint에 있는지 확인...')
  const baseline = await loginProbe()
  if (baseline.status !== 401) {
    throw new Error(`사전 확인 실패 — status=${baseline.status} (401 기대). 스택 상태를 먼저 점검하세요.`)
  }
  if (!getReadyEndpointIps().has(targetIp)) {
    throw new Error(`대상 Pod IP(${targetIp})가 애초에 Endpoint 목록에 없습니다 — Ready 판정을 다시 확인하세요.`)
  }

  console.log(`${targetName} Pod를 delete합니다...`)
  kubectl(['delete', 'pod', targetName, '-n', K8S_NAMESPACE, '--wait=false'])

  console.log('Endpoint 목록에서 대상 Pod IP가 빠질 때까지 대기(최대 30초)...')
  const excluded = await waitUntil(() => !getReadyEndpointIps().has(targetIp), 30_000, 1000)

  console.log('제외돼 있는 동안 로그인 요청이 계속 401(정상 처리)인지 15초간 확인 (나머지 1개 Pod로만 라우팅돼야 함)...')
  const duringFaultStatuses = []
  const probeDeadline = Date.now() + 15_000
  while (Date.now() < probeDeadline) {
    duringFaultStatuses.push((await loginProbe()).status)
    await new Promise((r) => setTimeout(r, 1000))
  }
  const remainingTargetServedNormally = duringFaultStatuses.length > 0 && duringFaultStatuses.every((s) => s === 401)

  console.log('Session 계약 확인: 실 계정으로 로그인 → 보호 API 왕복...')
  const sessionResult = await checkSessionRoundTrip()

  console.log(`대체 Pod가 기동해 Ready Pod 수가 ${originalReadyCount}으로 복구될 때까지 대기(최대 3분)...`)
  const recovered = await waitUntil(() => getReadyPods().length >= originalReadyCount, 180_000, 3000)

  const pass = excluded && remainingTargetServedNormally && sessionResult.ok && recovered
  console.log(
    `excluded=${excluded} remainingTargetServedNormally=${remainingTargetServedNormally} ` +
      `sessionOk=${sessionResult.ok}(step=${sessionResult.step}, status=${sessionResult.status ?? '(none)'}) recovered=${recovered}`,
  )
  console.log(pass ? 'OPS-005 PASS' : 'OPS-005 FAIL')

  writeResult({
    targetName,
    targetIp,
    excluded,
    duringFaultStatuses,
    remainingTargetServedNormally,
    sessionResult,
    recovered,
    originalReadyCount,
    pass,
  })
  process.exit(pass ? 0 : 1)
}

function writeResult({
  targetName,
  targetIp,
  excluded,
  duringFaultStatuses,
  remainingTargetServedNormally,
  sessionResult,
  recovered,
  originalReadyCount,
  pass,
}) {
  const reportsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'reports')
  const runId = process.env.DORO_RUN_ID || `run-ops-${Date.now()}`
  const record = {
    schemaVersion: 1,
    runId,
    testCaseId: 'OPS-005',
    testCaseAttempt: 1,
    layer: 'API_DIRECT',
    resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    environment: process.env.DORO_ENVIRONMENT ?? 'dev',
    targetHost: new URL(EDGE_ORIGIN).host,
    deployment: {
      frontendRevision: 'unknown',
      cloudFrontDistributionId: 'unknown',
      edgeRevision: 'unknown',
      storeAccessRevision: 'unknown',
    },
    accountAlias: 'AUTH_VALID_01',
    expected: {
      excludedFromEndpoints: true,
      remainingTargetServedNormally: true,
      sessionRoundTripOk: true,
      recoveredReadyCount: originalReadyCount,
    },
    observed: {
      targetPod: targetName,
      targetIp,
      excluded,
      duringFaultStatuses,
      sessionStep: sessionResult.step,
      sessionStatus: sessionResult.status ?? null,
      recovered,
    },
    requestId: null,
    assertions: {
      excludedFromEndpoints: excluded,
      remainingTargetServedNormally,
      sessionRoundTripOk: sessionResult.ok === true,
      recoveredToOriginalReadyCount: recovered,
    },
    artifacts: { failureScreenshot: null },
    errorClass: pass ? null : 'ASSERTION_MISMATCH',
  }
  mkdirSync(reportsDir, { recursive: true })
  const outPath = resolve(reportsDir, `${runId}.ops-005.results.jsonl`)
  writeFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8')
  console.log(`결과 기록: reports/${runId}.ops-005.results.jsonl`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
