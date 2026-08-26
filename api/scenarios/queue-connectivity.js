import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, getJson, header, parseProblem } from '../lib/http.js'
import { randomUuidV4 } from '../lib/provisioning.js'
import { record } from '../lib/resultLogger.js'

// QUEUE-001, QUEUE-002 (Tier A) — 배포 Frontend–Backend 종단 검증.md §10 확장 서비스 연결성 검증.
// AUTH_VALID_01(OWNER)만 있으면 되는 비파괴 조회라 항상 실행된다(SESS-001과 같은 성격 —
// Edge → queue-api 라우팅이 살아 있는지 확인하는 단일 인증 GET). QUEUE-003(Tier B)은 실제로
// Entry를 등록·취소하는 상태 변경 흐름이라 RUN_DESTRUCTIVE_QUEUE_TESTS=true를 명시해야 실행된다
// (README·api/README.md 참고).
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

const DESTRUCTIVE_FLAG = 'RUN_DESTRUCTIVE_QUEUE_TESTS'
const ALWAYS_ON_IDS = ['QUEUE-001', 'QUEUE-002']

function todayBusinessDate() {
  return new Date().toISOString().slice(0, 10)
}

export default function () {
  const env = loadDeployEnv()
  const loginUrl = `${env.apiOrigin}/api/v1/auth/login`
  const entryUrl = `${env.apiOrigin}/api/v1/queues/entry`
  const fulfillmentUrl = `${env.apiOrigin}/api/v1/queues/fulfillment`
  const account = env.authValid01
  const businessDate = todayBusinessDate()

  const jar = freshJar()
  const loginRes = postJson(
    loginUrl,
    { tenantCode: account.tenantCode, loginId: account.loginId, password: account.password },
    { jar },
  )
  if (loginRes.status !== 200) {
    const startedAt = new Date().toISOString()
    const idsToSkip = __ENV[DESTRUCTIVE_FLAG] === 'true' ? [...ALWAYS_ON_IDS, 'QUEUE-003'] : ALWAYS_ON_IDS
    for (const id of idsToSkip) {
      record(env, {
        testCaseId: id,
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_VALID_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: `사전 로그인 실패 (status=${loginRes.status}) — QUEUE-* 전제조건 불충족`,
      })
    }
    return
  }

  group('QUEUE-001: Fulfillment Queue 조회 (Edge → queue-api 라우팅 확인)', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = getJson(fulfillmentUrl, { jar })
    const pass = res.status === 200
    check(null, { 'QUEUE-001 200': () => pass })
    record(env, {
      testCaseId: 'QUEUE-001',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_PROTECTED_FLOW',
      expected: { requestPath: '/api/v1/queues/fulfillment', httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status200: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('QUEUE-002: Entry Queue 목록 조회 (businessDate 필수 파라미터)', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = getJson(`${entryUrl}?businessDate=${businessDate}`, { jar })
    const pass = res.status === 200
    check(null, { 'QUEUE-002 200': () => pass })
    record(env, {
      testCaseId: 'QUEUE-002',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_PROTECTED_FLOW',
      expected: { requestPath: '/api/v1/queues/entry', httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status200: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  if (__ENV[DESTRUCTIVE_FLAG] !== 'true') {
    record(env, {
      testCaseId: 'QUEUE-003',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: 'SKIP_PRECONDITION',
      errorClass: `${DESTRUCTIVE_FLAG}=true로 명시하지 않으면 실행하지 않음`,
    })
    return
  }

  group('QUEUE-003: 등록 → WAITING 확인 → 취소 → CANCELLED 확인 → 재취소 충돌', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()

    // 이 Entry는 실 테넌트 store+businessDate Counter의 queueNumber 1개를 영구히 소비하고
    // CANCELLED 행을 남긴다 — EntryQueueController.java/EntryQueueService.java 확인 완료,
    // 실 배포 대상 데이터에 대한 무해하지만 영구적인 부작용으로 감수한다(사양 문서 §10 참고).
    const idempotencyKey = randomUuidV4()
    const registerRes = postJson(
      entryUrl,
      { businessDate, partySize: 2 },
      { jar, headers: { 'Idempotency-Key': idempotencyKey } },
    )
    const registerBody = parseProblem(registerRes)
    const registered = registerRes.status === 201 && registerBody.status === 'WAITING'
    const entryId = registerBody.entryId

    let listedWaiting = false
    let cancelStatus = null
    let cancelledOk = false
    let repeatCancelStatus = null
    let repeatCancelCode = null
    let repeatConflictOk = false

    try {
      if (registered && entryId) {
        const listRes = getJson(`${entryUrl}?businessDate=${businessDate}`, { jar })
        const listBody = parseProblem(listRes)
        listedWaiting =
          listRes.status === 200 &&
          Array.isArray(listBody) &&
          listBody.some((e) => e.entryId === entryId && e.status === 'WAITING')
      }
    } finally {
      // 앞의 목록 조회 단언이 실패해도 등록된 Entry가 WAITING 상태로 방치되지 않도록, 등록에
      // 성공했다면 취소는 반드시 시도한다(verify-partial-pod-failure.mjs의 finally 기반 복구와
      // 같은 "항상 정리 시도" 철학).
      if (registered && entryId) {
        const cancelRes = postJson(`${entryUrl}/${entryId}/cancel`, {}, { jar })
        const cancelBody = parseProblem(cancelRes)
        cancelStatus = cancelRes.status
        cancelledOk = cancelRes.status === 200 && cancelBody.status === 'CANCELLED'

        // 이미 CANCELLED인 Entry를 다시 취소하면 STATE_CONFLICT(409)여야 한다 —
        // QueueErrorCode.java(STATE_CONFLICT → HttpStatus.CONFLICT) 확인 완료.
        const repeatRes = postJson(`${entryUrl}/${entryId}/cancel`, {}, { jar })
        const repeatBody = parseProblem(repeatRes)
        repeatCancelStatus = repeatRes.status
        repeatCancelCode = repeatBody.code || null
        repeatConflictOk = repeatRes.status === 409 && repeatBody.code === 'STATE_CONFLICT'
      }
    }

    const pass = registered && listedWaiting && cancelledOk && repeatConflictOk
    check(null, { 'QUEUE-003 등록→WAITING→취소→CANCELLED→재취소 충돌': () => pass })
    record(env, {
      testCaseId: 'QUEUE-003',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: {
        registerHttpStatus: 201,
        cancelHttpStatus: 200,
        repeatCancelHttpStatus: 409,
      },
      observed: {
        registerHttpStatus: registerRes.status,
        entryId: entryId || null,
        cancelHttpStatus: cancelStatus,
        repeatCancelHttpStatus: repeatCancelStatus,
        repeatCancelCode,
      },
      requestId: header(registerRes, 'X-Request-Id'),
      assertions: {
        registered,
        listedWaiting,
        cancelledOk,
        repeatConflictOk,
      },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })
}

// handleSummary()는 일부러 두지 않는다 — session-flow.js/auth-lockout-ratelimit.js와 같은 이유
// (resultLogger.js 주석 참고). summary.json/junit.xml은 `--log-format=raw` stdout을
// api/lib/build-report.mjs로 후처리해서 만든다.
