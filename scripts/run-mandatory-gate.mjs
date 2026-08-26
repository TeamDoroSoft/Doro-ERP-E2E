#!/usr/bin/env node
// 필수 게이트 — 배포 Frontend–Backend 종단 검증.md §3(필수 Gate) + §5(공통 계약 재검증
// 대표 Slice) + §6의 OPS-004(비파괴 관찰) + §7(PASS_CONNECTED 최종 판정)을 한 번에 실행한다.
//
// 여기 포함된 항목은 전부 파괴적 플래그 없이도 안전하다 — 실행 못 할 조건(Fixture·전용 정적
// 계정 부재)을 만나면 각 케이스가 스스로 SKIP_PRECONDITION으로 넘어갈 뿐, 컨테이너를
// 멈추거나 계정을 잠그거나 Pod를 지우는 동작은 이 게이트에 전혀 없다. 그래서 CI에서 매
// 배포마다 완전 자동으로 돌려도 안전하다 — README.md "실행" 절이 사람이 순서대로 타이핑하던
// 걸 그대로 코드로 옮긴 것.
//
// 필수 값(DORO_FRONTEND_ORIGIN, DORO_API_ORIGIN, DORO_AUTH_VALID_01_*)은 이 스크립트가 아니라
// 각 하위 실행이 loadDeployEnv()로 직접 요구한다 — 미리 export해두고 실행할 것(README 참고).
import { pathToFileURL } from 'node:url'
import { ensureRunId, runStep, runPlaywrightSpec, runK6Scenario, runNodeScript, printFinalSummary } from './lib/gate-steps.mjs'

// AUTH_VALID_01 Rate Limit Bucket(용량 5, 분당 1 리필) 순서 문제: Playwright 필수 Gate가 이
// 계정으로 로그인을 여러 번(FE-BE-001~006 각 케이스), 이어서 auth-mandatory.js가 4회
// (AUTH-001+002+024 묶음, AUTH-003, AUTH-004, AUTH-010), 다시 session-flow.js가 3회(최초
// 로그인 1회 + SESS-007 내부의 사전 로그인·재로그인 2회 — 파일 자체 주석엔 "1회만 소비"라고
// 적혀 있지만 실제로는 3회다)를 순서대로 소비한다. 대기 없이 이어 실행하면 용량 5를 넘겨
// 뒤 단계가 실제 결함이 아닌 429로 실패한다 — 각 단계 사이에 Bucket이 완전히 다시 찰 만큼
// (용량 5 ÷ 분당 1 리필 = 5분) 대기한다.
const AUTH_VALID_01_BUCKET_REFILL_WAIT_MS = 5 * 60 * 1000

async function waitForAuthValid01BucketRefill(afterStepName) {
  console.log(
    `  ⏳ ${afterStepName}가 AUTH_VALID_01의 Rate Limit Bucket을 소진시켰을 수 있습니다 — ` +
      `다음 단계가 잘못된 429로 실패하지 않도록 ${AUTH_VALID_01_BUCKET_REFILL_WAIT_MS / 1000}초 대기합니다.`,
  )
  await new Promise((r) => setTimeout(r, AUTH_VALID_01_BUCKET_REFILL_WAIT_MS))
}

export async function runMandatoryGate() {
  const runId = ensureRunId()
  console.log(`필수 게이트 시작 (DORO_RUN_ID=${runId})`)

  const steps = []

  steps.push(
    await runStep('FE-BE-001~006 (Playwright 필수 Gate)', () => runPlaywrightSpec('tests/fe-be-mandatory.spec.ts')),
  )

  await waitForAuthValid01BucketRefill('FE-BE-001~006')

  steps.push(
    await runStep('AUTH-001~004,010,020~024 (k6 auth-mandatory)', () =>
      runK6Scenario('api/scenarios/auth-mandatory.js', 'auth-mandatory', [
        'AUTH-001', 'AUTH-002', 'AUTH-003', 'AUTH-004',
        'AUTH-010', 'AUTH-020', 'AUTH-021', 'AUTH-022', 'AUTH-023', 'AUTH-024',
      ]),
    ),
  )

  steps.push(
    // AUTH-015는 mandatoryIds에서 뺐다 — RUN_DESTRUCTIVE_AUTH_TESTS=true일 때만 실행되는데
    // (auth-account-nonexposure.js 참고) 이 필수 게이트는 그 플래그를 절대 켜지 않으므로
    // AUTH-015는 이 스크립트 안에서 항상 SKIP_PRECONDITION이다. buildSummaryJson의
    // mandatoryApiPassed는 "전부 PASS"를 요구해 SKIP도 실패로 치므로, mandatoryIds에 넣어두면
    // 정상적으로(SKIP으로) 끝나도 종합 판정이 항상 실패한다 — AUTH-011~014만 필수로 집계한다.
    // AUTH-015 자체 결과는 그대로 실행·기록되며(results.jsonl/junit.xml), 필수 통과 판정에서만
    // 빠진다.
    await runStep('AUTH-011~015 (k6 계정 존재 비노출)', () =>
      runK6Scenario('api/scenarios/auth-account-nonexposure.js', 'auth-account-nonexposure', [
        'AUTH-011', 'AUTH-012', 'AUTH-013', 'AUTH-014',
      ]),
    ),
  )

  await waitForAuthValid01BucketRefill('AUTH-001~004,010,020~024')

  steps.push(
    await runStep('SESS-001~003,006,007 (+004/005 조건부) (k6 session-flow)', () =>
      runK6Scenario('api/scenarios/session-flow.js', 'session-flow', [
        'SESS-001', 'SESS-002', 'SESS-003', 'SESS-006', 'SESS-007', 'SESS-004', 'SESS-005',
      ]),
    ),
  )

  steps.push(
    await runStep('OPS-004 (TLS·CloudFront→ALB 경로, 비파괴 관찰)', () =>
      runNodeScript('scripts/verify-edge-boundary.mjs'),
    ),
  )

  steps.push(
    await runStep('종합 판정 (build-combined-summary)', () =>
      runNodeScript('scripts/build-combined-summary.mjs', [runId]),
    ),
  )

  return steps
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const steps = await runMandatoryGate()
  const allOk = printFinalSummary(steps)
  process.exit(allOk ? 0 : 1)
}
