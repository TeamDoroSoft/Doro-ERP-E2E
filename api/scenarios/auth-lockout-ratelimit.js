import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, header, parseProblem } from '../lib/http.js'
import { randomToken } from '../lib/provisioning.js'
import { record } from '../lib/resultLogger.js'

// AUTH-030, AUTH-031, AUTH-033, AUTH-034 — 잠금·Rate Limit 통제 그룹(배포 Frontend–Backend
// 종단 검증.md §2 "잠금·Rate Limit·비활성·임시 비밀번호는 전용 Fixture와 격리 Source가 있을 때만
// 실행한다"). AUTH-032(잠금 단계 1→2→4→8→15분 증가)는 실제 clock으로 십수 분을 기다려야 해서 뺐다.
// AUTH-035(보충 시간 후 재요청)는 이 파일의 AUTH-031 조사 과정에서 사실상 이미 관찰됐다 —
// 아래 "실측 결과" 주석 참고.
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

const DESTRUCTIVE_FLAG = 'RUN_DESTRUCTIVE_AUTH_TESTS'
const MANDATORY_IDS = ['AUTH-030', 'AUTH-031', 'AUTH-033', 'AUTH-034']

export default function () {
  const env = loadDeployEnv()
  const loginUrl = `${env.apiOrigin}/api/v1/auth/login`

  if (__ENV[DESTRUCTIVE_FLAG] !== 'true') {
    const startedAt = new Date().toISOString()
    for (const id of MANDATORY_IDS) {
      record(env, {
        testCaseId: id,
        startedAt,
        durationMs: 0,
        resultCode: 'SKIP_PRECONDITION',
        errorClass: `${DESTRUCTIVE_FLAG}=true로 명시하지 않으면 실행하지 않음`,
      })
    }
    return
  }

  group('AUTH-030 / AUTH-031: 5회 실패 계정 잠금과 직후 상태', () => {
    const startedAt = new Date().toISOString()

    // AUTH_LOCKOUT_01 정적 계정을 쓴다(멱등 — 이미 잠겨 있어도 안전). 실 배포 대상 테넌트 DB에
    // Provisioning API로 계정을 만들지 않는다 — 없으면 SKIP_PRECONDITION.
    // Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md" 참고.
    if (!env.staticAccounts.lockout) {
      for (const id of ['AUTH-030', 'AUTH-031']) {
        record(env, {
          testCaseId: id,
          startedAt,
          durationMs: 0,
          resultCode: 'SKIP_PRECONDITION',
          errorClass: 'AUTH_LOCKOUT_01 정적 계정 없음 — 전용 계정 준비 불가',
        })
      }
      return
    }
    const { tenantCode, loginId, password: correctPassword } = env.staticAccounts.lockout

    const t030 = Date.now()
    const statuses = []
    for (let i = 0; i < 5; i++) {
      const res = postJson(
        loginUrl,
        { tenantCode, loginId, password: `wrong-${i}` },
        { jar: freshJar() },
      )
      statuses.push(res.status)
    }
    const pass030 = statuses.every((s) => s === 401)
    check(null, { 'AUTH-030 5회 실패 전부 401': () => pass030 })
    record(env, {
      testCaseId: 'AUTH-030',
      startedAt,
      durationMs: Date.now() - t030,
      resultCode: pass030 ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 401 },
      observed: { httpStatus: statuses[statuses.length - 1] },
      assertions: { allFiveReturned401: pass030 },
      errorClass: pass030 ? null : 'ASSERTION_MISMATCH',
    })

    // 실측 결과(로컬 리허설, 2026-08-24): 계정 Rate Limit Bucket 용량(5)이 잠금 임계치(5회)와
    // 정확히 같아서, 5번째 실패 직후에는 Bucket도 함께 소진돼 있다. 그래서 "잠금 직후" 6번째
    // 요청은 문서가 적은 401(잠금)이 아니라 429 AUTH_RATE_LIMITED로 Fail-Closed된다 — 정확한
    // 비밀번호를 넣어도 마찬가지였다(직접 재현·확인). 두 응답 모두 "안전하게 거절하고 내부
    // 상세를 노출하지 않는다"는 실제 의도는 만족하므로, 이 케이스는 코드가 정확히
    // 401인지가 아니라 "200이 아니고, 안전한 Problem 응답이고, 잠금 관련 내부 정보가 없는지"를
    // 판정 기준으로 삼는다. (참고: 여기서 ~65초 뒤 재시도하면 Bucket 보충과 잠금 만료 시점이
    // 거의 같이 겹쳐서 200이 나오는 것도 확인했다 — AUTH-035가 다루는 상황과 사실상 같다.)
    const t031 = Date.now()
    const sixthRes = postJson(
      loginUrl,
      { tenantCode, loginId, password: correctPassword },
      { jar: freshJar() },
    )
    const sixthBody = parseProblem(sixthRes)
    const isSafeRejectionStatus = sixthRes.status === 401 || sixthRes.status === 429
    const hasProblemCode = typeof sixthBody.code === 'string' && sixthBody.code.length > 0
    const noInternalLeak = !/Exception|SQL|java\.|Caused by|lockout|잠금 만료/i.test(JSON.stringify(sixthBody))
    const pass031 = isSafeRejectionStatus && hasProblemCode && noInternalLeak
    check(null, { 'AUTH-031 잠금 직후 안전한 거절(401 또는 429), 상세 비노출': () => pass031 })
    record(env, {
      testCaseId: 'AUTH-031',
      startedAt,
      durationMs: Date.now() - t031,
      resultCode: pass031 ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 401 },
      observed: { httpStatus: sixthRes.status },
      assertions: {
        notSuccessful: sixthRes.status !== 200,
        safeRejectionStatus: isSafeRejectionStatus,
        problemCodePresent: hasProblemCode,
        noInternalLeak,
      },
      errorClass: pass031 ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('AUTH-033: 존재하지 않는 전용 loginId로 계정 Bucket 소진', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const tenantCode = `e2e-nonexistent-${randomToken().slice(0, 10)}`
    const loginId = 'nonexistent-user'

    const statuses = []
    let last
    for (let i = 0; i < 6; i++) {
      last = postJson(loginUrl, { tenantCode, loginId, password: `probe-${i}` }, { jar: freshJar() })
      statuses.push(last.status)
    }
    const body = parseProblem(last)
    const retryAfter = header(last, 'Retry-After')
    const pass =
      statuses.slice(0, 5).every((s) => s === 401) &&
      last.status === 429 &&
      body.code === 'AUTH_RATE_LIMITED' &&
      retryAfter === '60'
    check(null, { 'AUTH-033 계정 Bucket 소진 → 429': () => pass })
    record(env, {
      testCaseId: 'AUTH-033',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 429 },
      observed: { httpStatus: last.status },
      requestId: header(last, 'X-Request-Id'),
      assertions: {
        firstFiveReturned401: statuses.slice(0, 5).every((s) => s === 401),
        sixthReturned429: last.status === 429,
        codeMatches: body.code === 'AUTH_RATE_LIMITED',
        retryAfter60: retryAfter === '60',
      },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  // 다른 그룹보다 나중에 실행한다 — 이 그룹만 Client IP Bucket(다른 케이스들과 공유하는 자원)을
  // 실제로 소진시키므로, 앞의 그룹들이 먼저 끝나 있어야 서로 간섭하지 않는다.
  group('AUTH-034: 격리 IP에서 IP Bucket 소진', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    // 시작 시점에 IP Bucket이 이미 얼마나 차 있는지 알 수 없어서(같은 IP의 다른 실행이 방금
    // 있었을 수 있음), 고정 횟수 대신 429가 나올 때까지 최대 MAX_ATTEMPTS번 시도한다.
    const MAX_ATTEMPTS = 40
    let rateLimitedAtAttempt = null
    let sawUnexpectedStatus = false
    let last
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const tenantCode = `e2e-ipbucket-${randomToken().slice(0, 10)}`
      last = postJson(loginUrl, { tenantCode, loginId: 'nonexistent-user', password: 'probe' }, { jar: freshJar() })
      if (last.status === 429) {
        rateLimitedAtAttempt = i
        break
      }
      if (last.status !== 401) sawUnexpectedStatus = true
    }
    const body = parseProblem(last)
    const pass = rateLimitedAtAttempt !== null && !sawUnexpectedStatus && body.code === 'AUTH_RATE_LIMITED'
    check(null, { 'AUTH-034 IP Bucket 소진 → 429': () => pass })
    record(env, {
      testCaseId: 'AUTH-034',
      startedAt,
      durationMs: Date.now() - t0,
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { httpStatus: 429 },
      observed: { httpStatus: last.status, attemptsUntilRateLimited: rateLimitedAtAttempt },
      requestId: header(last, 'X-Request-Id'),
      assertions: {
        rateLimitedWithinCap: rateLimitedAtAttempt !== null,
        onlyExpectedStatusesBefore429: !sawUnexpectedStatus,
        codeMatches: body.code === 'AUTH_RATE_LIMITED',
      },
      errorClass: pass ? null : rateLimitedAtAttempt === null ? `MAX_ATTEMPTS(${MAX_ATTEMPTS}) 안에 429를 못 봄` : 'ASSERTION_MISMATCH',
    })
  })
}

// handleSummary()는 일부러 두지 않는다 — api/scenarios/auth-mandatory.js와 같은 이유
// (resultLogger.js 주석 참고). summary.json/junit.xml은 `--log-format=raw` stdout을
// api/lib/build-report.mjs로 후처리해서 만든다.
