import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, header, parseProblem } from '../lib/http.js'
import { randomToken } from '../lib/provisioning.js'
import { record } from '../lib/resultLogger.js'

// AUTH-034는 CloudFront·ALB·VPC Origin의 실제 client IP 전달 형태에 의존한다. 현재 E2E 출력만으로는
// 실패 원인을 판별할 수 없으므로 배포 게이트가 아닌 명시적 환경 진단으로만 실행한다.
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

const DIAGNOSTIC_FLAG = 'RUN_AUTH_IP_DIAGNOSTIC'
const MAX_ATTEMPTS = 40

export default function () {
  const env = loadDeployEnv()
  const startedAt = new Date().toISOString()

  if (__ENV[DIAGNOSTIC_FLAG] !== 'true') {
    record(env, {
      testCaseId: 'AUTH-034',
      startedAt,
      durationMs: 0,
      resultCode: 'SKIP_PRECONDITION',
      errorClass: `${DIAGNOSTIC_FLAG}=true로 명시하지 않으면 실행하지 않는 환경 진단`,
    })
    return
  }

  group('AUTH-034: 격리 IP에서 IP Bucket 소진 진단', () => {
    const t0 = Date.now()
    const loginUrl = `${env.apiOrigin}/api/v1/auth/login`
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
