#!/usr/bin/env node
// OPS-004(배포 Frontend–Backend 종단 검증.md §6 "Infra 전용 시나리오") — TLS·Host·CloudFront→ALB
// 경로와 내부 Ingress 직접 접근 차단을 확인한다. 파괴적이지 않은 관찰형 검증이라 OPS-001/003과
// 달리 --confirm이 필요 없다 — 아무것도 멈추거나 바꾸지 않고 그냥 요청만 보낸다.
//
// 두 부분으로 나뉜다:
//   1) 공개 경로: DORO_FRONTEND_ORIGIN(CloudFront)이 유효한 HTTPS로 실제 Edge API까지 도달하는지.
//   2) 내부 Ingress 차단: 내부 ALB(Gateway)에 직접 접근하면 막히는지. 이 ALB는 `internal` Scheme이라
//      DNS는 공개적으로 조회되지만 가리키는 IP가 사설(RFC1918) 대역이다 — 그래서 VPC 밖에서는
//      403 같은 명시적 거부가 아니라 그냥 연결 자체가 안 되는(Timeout) 것으로 나타난다(실측 확인).
//      ALB 이름은 고정 상수로 넣지 않고 매번 `aws elbv2 describe-load-balancers`로 조회한다 —
//      ALB가 재생성되면 DNS 값이 바뀔 수 있어서다.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_ORIGIN = (process.env.DORO_FRONTEND_ORIGIN ?? 'https://doro.minseok.click').replace(/\/$/, '')
const INTERNAL_ALB_NAME = process.env.INTERNAL_ALB_NAME ?? 'doro-erp-prod-alpha-gateway'

if (!PUBLIC_ORIGIN.startsWith('https://')) {
  console.error(`DORO_FRONTEND_ORIGIN=${PUBLIC_ORIGIN} 는 HTTPS가 아닙니다 (ERROR_CONFIG) — OPS-004는 실 배포 대상 전용이다.`)
  process.exit(2)
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

// 1) 공개 경로 — TLS 유효성은 fetch가 자체 서명 인증서를 자동으로 거부하므로 예외 없이 응답을
// 받는 것 자체가 "유효한 HTTPS" 증거다. CloudFront 경유 여부는 Header로, 실제 Edge API(S3
// 정적 파일이 아니라)까지 닿았는지는 Problem+JSON 응답 모양으로 판별한다.
async function checkPublicEdge(origin) {
  const url = `${origin}/api/v1/auth/login`
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantCode: 'ops-004-probe', loginId: 'probe', password: 'probe' }),
      },
      10000,
    )
    const viaHeader = res.headers.get('via') ?? ''
    const server = res.headers.get('server') ?? ''
    const reachedCloudFront = viaHeader.toLowerCase().includes('cloudfront') || res.headers.get('x-amz-cf-id') !== null
    let body = {}
    try {
      body = await res.json()
    } catch {
      // S3 오류 응답은 XML이라 JSON 파싱이 실패한다 — 그 자체가 "Edge까지 못 닿았다"는 증거다.
    }
    const reachedEdgeApi = res.status === 401 && body.code === 'AUTHENTICATION_FAILED'
    return { ok: true, status: res.status, reachedCloudFront, reachedEdgeApi, server, body }
  } catch (error) {
    return { ok: false, transportError: error instanceof Error ? error.message : String(error) }
  }
}

// 2) 내부 Ingress 직접 접근 — 정상적인 경우 이 fetch는 "응답을 받아서" 실패하는 게 아니라
// "연결 자체가 안 돼서" 실패해야 한다(사설 IP라 라우팅이 안 됨). 그래서 여기서 예외가 나는 게
// PASS, 정상 응답이 오는 게 FAIL이다 — 다른 check들과 성패 방향이 반대라는 점에 주의.
function resolveInternalAlbDns(albName) {
  const raw = execFileSync(
    'aws',
    ['elbv2', 'describe-load-balancers', '--names', albName, '--query', 'LoadBalancers[0].DNSName', '--output', 'text'],
    { encoding: 'utf8' },
  ).trim()
  if (!raw || raw === 'None') {
    throw new Error(`ALB를 찾지 못했습니다: ${albName} — AWS_PROFILE과 이름을 확인하세요.`)
  }
  return raw
}

async function checkInternalIngressBlocked(albDns) {
  try {
    const res = await fetchWithTimeout(`https://${albDns}/`, {}, 8000)
    // 응답이 왔다 — 내부 Ingress가 외부에서 직접 접근 가능하다는 뜻이라 실패다.
    return { blocked: false, status: res.status }
  } catch (error) {
    // Timeout·연결 거부·DNS 실패 전부 "차단됨"으로 인정한다 — 사설 IP라 어떤 형태로 막히든
    // 외부에서 접근 못 하는 게 핵심이지, 에러의 정확한 종류는 중요하지 않다.
    return { blocked: true, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  console.log(`[OPS-004] 공개 경로 확인: ${PUBLIC_ORIGIN}/api/v1/auth/login`)
  const publicResult = await checkPublicEdge(PUBLIC_ORIGIN)
  if (publicResult.ok) {
    console.log(
      `  status=${publicResult.status} reachedCloudFront=${publicResult.reachedCloudFront} ` +
        `reachedEdgeApi=${publicResult.reachedEdgeApi} server=${publicResult.server || '(none)'}`,
    )
  } else {
    console.log(`  전송 실패: ${publicResult.transportError}`)
  }

  console.log(`[OPS-004] 내부 ALB 조회: ${INTERNAL_ALB_NAME}`)
  let albDns = null
  let internalResult = { blocked: false, reason: 'ALB 조회 실패로 확인 못 함' }
  try {
    albDns = resolveInternalAlbDns(INTERNAL_ALB_NAME)
    console.log(`  DNS: ${albDns}`)
    console.log('[OPS-004] 내부 Ingress 직접 접근 시도 (연결 자체가 실패해야 정상)...')
    internalResult = await checkInternalIngressBlocked(albDns)
    console.log(
      internalResult.blocked
        ? `  차단 확인됨: ${internalResult.reason}`
        : `  ⚠ 응답이 왔습니다(status=${internalResult.status}) — 내부 Ingress가 외부에 노출된 것으로 보입니다.`,
    )
  } catch (error) {
    console.log(`  ALB 조회 실패: ${error instanceof Error ? error.message : error}`)
  }

  const pass =
    publicResult.ok &&
    publicResult.reachedCloudFront &&
    publicResult.reachedEdgeApi &&
    albDns !== null &&
    internalResult.blocked

  console.log(pass ? 'OPS-004 PASS' : 'OPS-004 FAIL')
  writeResult({ publicResult, albDns, internalResult, pass })
  process.exit(pass ? 0 : 1)
}

function writeResult({ publicResult, albDns, internalResult, pass }) {
  const reportsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'reports')
  const runId = process.env.DORO_RUN_ID || `run-ops-${Date.now()}`
  const record = {
    schemaVersion: 1,
    runId,
    testCaseId: 'OPS-004',
    testCaseAttempt: 1,
    layer: 'API_DIRECT',
    resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    environment: process.env.DORO_ENVIRONMENT ?? 'dev',
    targetHost: new URL(PUBLIC_ORIGIN).host,
    deployment: {
      frontendRevision: 'unknown',
      cloudFrontDistributionId: 'unknown',
      edgeRevision: 'unknown',
      storeAccessRevision: 'unknown',
    },
    accountAlias: null,
    expected: { reachedCloudFront: true, reachedEdgeApi: true, internalIngressBlocked: true },
    observed: {
      httpStatus: publicResult.status ?? null,
      reachedCloudFront: publicResult.reachedCloudFront ?? false,
      reachedEdgeApi: publicResult.reachedEdgeApi ?? false,
      internalAlbDns: albDns,
      internalIngressBlocked: internalResult.blocked,
    },
    requestId: null,
    assertions: {
      publicEdgeReachable: publicResult.ok === true,
      reachedCloudFront: publicResult.reachedCloudFront === true,
      reachedEdgeApi: publicResult.reachedEdgeApi === true,
      albResolved: albDns !== null,
      internalIngressBlocked: internalResult.blocked === true,
    },
    artifacts: { failureScreenshot: null },
    errorClass: pass ? null : 'ASSERTION_MISMATCH',
  }
  mkdirSync(reportsDir, { recursive: true })
  const outPath = resolve(reportsDir, `${runId}.ops-004.results.jsonl`)
  writeFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8')
  console.log(`결과 기록: reports/${runId}.ops-004.results.jsonl`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
