#!/usr/bin/env node
// OPS-002(Local Runtime 검증.md §4 "Provider 미승인 Cookie·Body → Edge 503 Fail-Closed";
// 배포 Frontend–Backend 종단 검증.md §5 "공통 계약의 배포 재검증" 대표 Slice)를 실 배포 EKS에서
// 검증한다.
//
// StoreAccessLoginForwarder.java(edge-api)를 확인한 결과, edge-api는 Store Access가 돌려주는
// 응답이 다음 중 하나라도 어긋나면 무조건 503 LOGIN_UNAVAILABLE로 거절한다: 성공 Body가 정확히
// {employeeId(UUID), role(OWNER/MANAGER/STAFF), passwordChangeRequired(boolean)} 3개 필드가
// 아닌 경우, 허용 Cookie(SESSION/XSRF-TOKEN) 외의 것, Cookie 속성(Secure/Path=//SameSite=Lax/
// HttpOnly) 불일치. 이 검증은 HMAC 서명 검증이 아니라 순수 응답 모양 검증이라 디코이가 진짜
// 서명 로직을 몰라도 된다 — 아무 POST에나 의도적으로 깨진 Body(필수 필드 없음)를 돌려주는
// 최소한의 HTTP 서버면 충분하다(아래 DECOY_SCRIPT).
//
// 라우팅 방법: 실 store-access-api Service의 spec.selector를 디코이 Pod의 label로 임시 교체한다.
// (검토했던 다른 방법 — edge-api Deployment의 STORE_ACCESS_INTERNAL_BASE_URL을 바꾸고 롤링
// 재시작 — 은 2번의 재시작이 필요해 느리고, 이 방법은 kube-proxy가 Endpoint를 즉시 갱신해
// 재시작 없이 즉시 반영·즉시 원복된다.)
//
// ⚠️ 영향 범위 주의: STORE_ACCESS_INTERNAL_BASE_URL 하나를 edge-api의 로그인뿐 아니라 Session
// Context·Kiosk Context·Management·비밀번호 변경 Forwarder 6개가 전부 공유한다. Service selector를
// 디코이로 바꾸는 동안에는 store-access-api를 향한 edge-api의 모든 통신(그리고 commerce-api 등
// 다른 소비자도 있다면 그쪽도)이 함께 영향을 받는다 — OPS-005(Pod 2개 중 1개만 빼서 나머지
// 1개가 계속 정상 응답)보다 영향 범위가 훨씬 넓다. 부트캠프 프로젝트라 실사용자 영향을 고려하지
// 않아도 된다는 전제로 설계했다 — 실사용자가 있는 환경에서는 이 스크립트를 쓰지 말 것.
//
// 주의: 이 스크립트는 사설(Private) EKS API Endpoint에 도달 가능하고 대상 namespace에서
// pods 생성/삭제, services/patch 권한이 있는 kubectl context가 필요하다. 이 스크립트를 작성한
// 환경에서는 그런 접근이 없어서 실제로 실행해 검증하지 못했다 — 최초 실행 전 결과를 반드시
// 직접 확인할 것.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const K8S_NAMESPACE = process.env.DORO_K8S_NAMESPACE ?? 'doro-alpha'
const K8S_SERVICE = process.env.DORO_K8S_STORE_ACCESS_SERVICE ?? 'store-access-api'
const EDGE_ORIGIN = (process.env.DORO_API_ORIGIN ?? 'https://doro.minseok.click').replace(/\/$/, '')
const DECOY_POD_NAME = 'ops-002-decoy'
const DECOY_LABEL_VALUE = 'store-access-api-ops002-decoy'

if (!process.argv.includes('--confirm')) {
  console.error(
    `OPS-002는 실 배포 ${K8S_NAMESPACE}/${K8S_SERVICE} Service의 selector를 디코이 Pod로 임시 교체합니다 ` +
      '(그동안 store-access-api를 쓰는 edge-api의 모든 통신이 함께 영향을 받습니다). ' +
      '승인된 점검 시간이 맞으면 --confirm을 붙여 다시 실행하세요.',
  )
  process.exit(2)
}

function kubectl(args, opts = {}) {
  return execFileSync('kubectl', args, { encoding: 'utf8', ...opts }).trim()
}

function kubectlJson(args) {
  return JSON.parse(kubectl([...args, '-o', 'json']))
}

function kubectlReachable() {
  try {
    kubectl(['get', 'service', K8S_SERVICE, '-n', K8S_NAMESPACE, '-o', 'name'])
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
        body: JSON.stringify({ tenantCode: 'ops-002-probe', loginId: 'probe', password: 'probe' }),
      },
      5000,
    )
    let body = {}
    try {
      body = await res.json()
    } catch {
      // no-op — body may be empty
    }
    return { status: res.status, body }
  } catch (error) {
    return { status: 0, body: {}, transportError: error instanceof Error ? error.message : String(error) }
  }
}

async function waitFor(probeAsync, isDone, { timeoutMs, intervalMs }) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeoutMs) {
    last = await probeAsync()
    if (isDone(last)) return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return last
}

// 아무 POST에나 의도적으로 깨진 Body(필수 3개 필드 없음)를 200으로 돌려준다 — edge-api의
// validateSuccess()가 Cookie를 보기도 전에 Body 모양에서 바로 unavailable()을 던지므로
// Cookie까지 흉내 낼 필요가 없다. Docker Hub 공개 이미지(node:20-alpine)만 있으면 되고
// 별도 이미지 빌드·ECR Push가 필요 없다.
const DECOY_SCRIPT =
  "const http=require('http');" +
  "http.createServer((req,res)=>{" +
  "let body='';req.on('data',c=>body+=c);" +
  "req.on('end',()=>{" +
  "res.writeHead(200,{'Content-Type':'application/json'});" +
  "res.end(JSON.stringify({malformed:'OPS-002 decoy intentionally invalid body'}));" +
  '});' +
  "}).listen(8081,()=>console.log('OPS-002 decoy listening on 8081'));"

function applyDecoyPod() {
  const manifest = `apiVersion: v1
kind: Pod
metadata:
  name: ${DECOY_POD_NAME}
  namespace: ${K8S_NAMESPACE}
  labels:
    app.kubernetes.io/name: ${DECOY_LABEL_VALUE}
    app.kubernetes.io/part-of: doro-erp-e2e-ops002
spec:
  restartPolicy: Never
  containers:
    - name: decoy
      image: node:20-alpine
      command: ["node", "-e", "${DECOY_SCRIPT.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]
      ports:
        - name: http
          containerPort: 8081
`
  kubectl(['apply', '-f', '-'], { input: manifest })
}

function deleteDecoyPod() {
  try {
    kubectl(['delete', 'pod', DECOY_POD_NAME, '-n', K8S_NAMESPACE, '--ignore-not-found', '--wait=false'])
  } catch (error) {
    // 정리 실패는 무시하고 계속 진행 — main()의 finally에서 이미 Service는 복원했으므로
    // 디코이 Pod가 잠깐 남아 있어도 실제 트래픽에는 영향이 없다. 다만 사람이 알아챌 수 있게 남긴다.
    console.error(
      `⚠ 디코이 Pod(${DECOY_POD_NAME}, namespace=${K8S_NAMESPACE}) 삭제 실패 — 수동으로 확인·정리 필요: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}

function getServiceSelector() {
  return kubectlJson(['get', 'service', K8S_SERVICE, '-n', K8S_NAMESPACE]).spec.selector
}

function patchServiceSelector(selector) {
  kubectl(['patch', 'service', K8S_SERVICE, '-n', K8S_NAMESPACE, '--type=merge', '-p', JSON.stringify({ spec: { selector } })])
}

async function waitForDecoyRunning(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (kubectl(['get', 'pod', DECOY_POD_NAME, '-n', K8S_NAMESPACE, '-o', 'jsonpath={.status.phase}']) === 'Running') {
        return true
      }
    } catch {
      // Pod가 아직 API에 안 보일 수 있다 — 계속 재시도.
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

async function main() {
  console.log(`[OPS-002] 대상: ${K8S_NAMESPACE}/${K8S_SERVICE} (Service selector 교체 방식)`)

  if (!kubectlReachable()) {
    throw new Error(
      `kubectl로 ${K8S_NAMESPACE}/${K8S_SERVICE}에 접근할 수 없습니다 — EKS 사설 API Endpoint에 도달 가능한 ` +
        'kubectl context와 해당 namespace에 대한 EKS Access Entry(RBAC, pods 생성/삭제·services/patch 권한)가 필요합니다.',
    )
  }

  const originalSelector = getServiceSelector()
  const selectorKeys = Object.keys(originalSelector ?? {})
  if (selectorKeys.length !== 1) {
    throw new Error(
      `Service selector가 예상과 다릅니다(${JSON.stringify(originalSelector)}) — 단일 key(app.kubernetes.io/name)만 ` +
        '지원합니다. 직접 확인 후 진행하세요.',
    )
  }
  const selectorKey = selectorKeys[0]
  console.log(`원래 selector 저장: ${JSON.stringify(originalSelector)}`)

  console.log('사전 확인: 정상 상태에서 로그인 요청이 401로 응답하는지 확인...')
  const baseline = await loginProbe()
  if (baseline.status !== 401) {
    throw new Error(`사전 확인 실패 — status=${baseline.status} (401 기대). 스택 상태를 먼저 점검하세요.`)
  }

  console.log('디코이 Pod 배포...')
  applyDecoyPod()
  const decoyReady = await waitForDecoyRunning()
  if (!decoyReady) {
    deleteDecoyPod()
    throw new Error('디코이 Pod가 시간 안에 Running 상태가 되지 않았습니다 — Service는 아직 원래 대상을 가리키고 있어 안전합니다.')
  }

  let faulted
  let restoredOk = true
  try {
    console.log(`Service selector를 디코이로 전환: ${JSON.stringify({ [selectorKey]: DECOY_LABEL_VALUE })}`)
    patchServiceSelector({ [selectorKey]: DECOY_LABEL_VALUE })

    console.log('전환 후 로그인 요청이 503(Fail-Closed)으로 응답하는지 확인(최대 20초)...')
    faulted = await waitFor(loginProbe, (r) => r.status === 503, { timeoutMs: 20000, intervalMs: 1000 })
  } finally {
    console.log('Service selector를 원래 대상으로 복원...')
    try {
      patchServiceSelector(originalSelector)
    } catch (error) {
      restoredOk = false
      console.error(`⚠ Service selector 복원 실패 — 수동으로 확인하세요: ${error instanceof Error ? error.message : error}`)
    }
    deleteDecoyPod()
  }

  console.log('복원 후 로그인 요청이 다시 401(정상 처리)로 돌아오는지 확인(최대 30초)...')
  const recovered = await waitFor(loginProbe, (r) => r.status === 401, { timeoutMs: 30000, intervalMs: 2000 })

  const faultDetected = faulted.status === 503
  const noInternalLeak = !/Exception|SQL|java\.|Caused by/i.test(JSON.stringify(faulted.body))
  const recoveredOk = recovered.status === 401 && restoredOk
  const pass = faultDetected && noInternalLeak && recoveredOk

  console.log(`fault: status=${faulted.status} code=${faulted.body.code ?? '(none)'}`)
  console.log(`recovered: status=${recovered.status} restoredOk=${restoredOk}`)
  console.log(pass ? 'OPS-002 PASS' : 'OPS-002 FAIL')

  writeResult({ pass, faulted, recovered, restoredOk, noInternalLeak })
  process.exit(pass ? 0 : 1)
}

function writeResult({ pass, faulted, recovered, restoredOk, noInternalLeak }) {
  const reportsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'reports')
  const runId = process.env.DORO_RUN_ID || `run-ops-${Date.now()}`
  const record = {
    schemaVersion: 1,
    runId,
    testCaseId: 'OPS-002',
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
    accountAlias: null,
    expected: { httpStatus: 503, recoveredHttpStatus: 401 },
    observed: { httpStatus: faulted.status, recoveredHttpStatus: recovered.status },
    requestId: null,
    assertions: {
      faultReturnedServiceUnavailable: faulted.status === 503,
      noInternalLeak,
      recoveredAfterRestore: recovered.status === 401,
      serviceSelectorRestored: restoredOk,
    },
    artifacts: { failureScreenshot: null },
    errorClass: pass ? null : 'ASSERTION_MISMATCH',
  }
  mkdirSync(resolve(reportsDir, runId), { recursive: true })
  const outPath = resolve(reportsDir, runId, 'ops-002.results.jsonl')
  writeFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8')
  console.log(`결과 기록: reports/${runId}/ops-002.results.jsonl`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
