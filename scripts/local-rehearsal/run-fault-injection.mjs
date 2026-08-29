#!/usr/bin/env node
// OPS-001(Store Access 장애)·OPS-003(Redis 장애) — 로컬 Docker Prod-like 스택 전용. 실제로
// 컨테이너를 멈췄다 다시 올린다. 이 스크립트를 실행하는 것 자체가 이미 "승인된 점검"이어야
// 한다(배포 Frontend–Backend 종단 검증.md §6의 운영 담당자 승인 원칙과 같은 정신) — 그래서
// --confirm 플래그를 명시적으로 요구하고, 컨테이너를 멈춘 뒤에는 무슨 일이 있어도(예외 발생
// 포함) 다시 올리는 것을 try/finally로 보장한다.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // 로컬 자체 서명 인증서 전용 스크립트

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EDGE_ORIGIN = 'https://localhost:8080'
const STORE_ACCESS_HEALTH_URL = 'https://localhost:8081/actuator/health'

const CONFIGS = {
  'OPS-001': {
    container: 'doro-erp-local-apps-store-access-api-1',
    label: 'Store Access API',
    healthUrl: STORE_ACCESS_HEALTH_URL,
  },
  'OPS-003': {
    container: 'doro-erp-local-test-redis-1',
    label: 'Redis',
    healthUrl: null, // Redis 자체 HTTP Health가 없다 — 재기동 후 고정 대기 + 로그인 재확인으로 대체
  },
}

const opsId = process.argv[2]
const config = CONFIGS[opsId]
if (!config) {
  console.error(`사용법: node scripts/local-rehearsal/run-fault-injection.mjs <${Object.keys(CONFIGS).join('|')}> --confirm`)
  process.exit(2)
}
if (!process.argv.includes('--confirm')) {
  console.error(
    `${opsId}는 실제로 ${config.label} 컨테이너(${config.container})를 멈췄다 올립니다. ` +
      '승인된 점검 시간이 맞으면 --confirm을 붙여 다시 실행하세요.',
  )
  process.exit(2)
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

function isRunning(container) {
  try {
    return docker(['inspect', '-f', '{{.State.Running}}', container]) === 'true'
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
        body: JSON.stringify({ tenantCode: 'fault-injection-probe', loginId: 'probe', password: 'probe' }),
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

async function main() {
  console.log(`[${opsId}] 대상: ${config.label} (${config.container})`)

  if (!isRunning(config.container)) {
    throw new Error(`${config.container}가 지금 실행 중이 아닙니다 — 먼저 정상 상태로 띄운 뒤 실행하세요.`)
  }

  console.log('사전 확인: 정상 상태에서 로그인 요청이 401(자격증명 불일치)로 응답하는지 확인...')
  const baseline = await loginProbe()
  if (baseline.status !== 401) {
    throw new Error(
      `사전 확인 실패 — 정상 상태인데 status=${baseline.status} (401 기대). 스택 상태를 먼저 점검하세요.`,
    )
  }

  let faulted
  let healthRecovered = true
  let recovered

  console.log(`${config.label} 컨테이너를 멈춥니다...`)
  docker(['stop', config.container])

  try {
    console.log('장애 상태에서 로그인 요청이 503으로 Fail-Closed되는지 확인...')
    faulted = await waitFor(loginProbe, (r) => r.status === 503, { timeoutMs: 15000, intervalMs: 1000 })
  } finally {
    console.log(`${config.label} 컨테이너를 다시 올립니다...`)
    docker(['start', config.container])
  }

  if (config.healthUrl) {
    console.log('Health Endpoint가 다시 UP이 될 때까지 대기...')
    const health = await waitFor(
      async () => {
        try {
          const r = await fetchWithTimeout(config.healthUrl, {}, 3000)
          const body = await r.json().catch(() => ({}))
          return { ok: r.status === 200 && body.status === 'UP' }
        } catch {
          return { ok: false }
        }
      },
      (r) => r.ok,
      { timeoutMs: 60000, intervalMs: 2000 },
    )
    healthRecovered = health.ok
  } else {
    await new Promise((r) => setTimeout(r, 5000))
  }

  console.log('복구 후 로그인 요청이 다시 401(정상 처리)로 돌아오는지 확인...')
  recovered = await waitFor(loginProbe, (r) => r.status === 401, { timeoutMs: 30000, intervalMs: 2000 })

  const faultDetected = faulted.status === 503
  const noInternalLeak = !/Exception|SQL|java\.|Caused by/i.test(JSON.stringify(faulted.body))
  const recoveredOk = recovered.status === 401 && healthRecovered
  const pass = faultDetected && noInternalLeak && recoveredOk

  console.log(`fault: status=${faulted.status} code=${faulted.body.code ?? '(none)'} transportError=${faulted.transportError ?? '(none)'}`)
  console.log(`recovered: status=${recovered.status} healthRecovered=${healthRecovered}`)
  console.log(pass ? `${opsId} PASS` : `${opsId} FAIL`)

  writeResult({ pass, faulted, recovered, healthRecovered, noInternalLeak })
  process.exit(pass ? 0 : 1)
}

function writeResult({ pass, faulted, recovered, healthRecovered, noInternalLeak }) {
  const reportsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports')
  const runId = process.env.DORO_RUN_ID || `run-ops-${Date.now()}`
  const record = {
    schemaVersion: 1,
    runId,
    testCaseId: opsId,
    testCaseAttempt: 1,
    layer: 'API_DIRECT',
    resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    environment: 'local-prod-like',
    targetHost: 'localhost:8080',
    deployment: {
      frontendRevision: 'unknown',
      cloudFrontDistributionId: 'unknown',
      edgeRevision: 'unknown',
      storeAccessRevision: 'unknown',
    },
    accountAlias: null,
    expected: { httpStatus: 503 },
    observed: { httpStatus: faulted.status, recoveredHttpStatus: recovered.status },
    requestId: null,
    assertions: {
      faultReturnedServiceUnavailable: faulted.status === 503,
      noInternalLeak,
      recoveredAfterRestart: recovered.status === 401,
      healthEndpointRecovered: healthRecovered,
    },
    artifacts: { failureScreenshot: null },
    errorClass: pass ? null : 'ASSERTION_MISMATCH',
  }
  mkdirSync(resolve(reportsDir, runId), { recursive: true })
  const outPath = resolve(reportsDir, runId, `${opsId.toLowerCase()}.results.jsonl`)
  writeFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8')
  console.log(`결과 기록: reports/${runId}/${opsId.toLowerCase()}.results.jsonl`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
