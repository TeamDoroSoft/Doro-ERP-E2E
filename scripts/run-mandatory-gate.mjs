#!/usr/bin/env node
// 필수 게이트 — 배포 Frontend–Backend 종단 검증.md §3(필수 Gate) + §5(공통 계약 재검증
// 대표 Slice) + §6의 OPS-004(비파괴 관찰) + §10의 QUEUE-001/002·CATALOG-001~003(확장 서비스
// 연결성 검증 Tier A) + §7(PASS_CONNECTED 최종 판정)을 한 번에 실행한다.
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
    // FE-BE-022(일별 매출 조회)도 같은 파일 안에 있다 — AUTH_ROLE_MANAGER_01/OWNER_01 정적 계정
    // 전제라 없으면 SKIP_PRECONDITION으로 끝나고, MANAGER 계정을 쓸 수 있으면 AUTH_VALID_01/
    // AUTH_ROLE_OWNER_01 공유 Bucket을 건드리지 않는다(browser/tests/fe-be-mandatory.spec.ts의
    // FE-BE-022 주석 참고). MANAGER가 없어 OWNER로 폴백하면 바로 아래 waitForAuthValid01BucketRefill
    // 전에 이 Bucket을 1회 더 쓴다는 뜻이므로, 그 폴백이 실제로 쓰였다면 이 대기 자체가 그 소비까지
    // 함께 흡수한다.
    await runStep('FE-BE-001~006,022 (Playwright 필수 Gate)', () => runPlaywrightSpec('tests/fe-be-mandatory.spec.ts')),
  )

  await waitForAuthValid01BucketRefill('FE-BE-001~006,022')

  steps.push(
    await runStep('AUTH-001~004,010,020~024 (k6 auth-mandatory)', () =>
      runK6Scenario('api/scenarios/auth-mandatory.js', 'AUTH-mandatory', [
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
      runK6Scenario('api/scenarios/auth-account-nonexposure.js', 'AUTH-nonexposure', [
        'AUTH-011', 'AUTH-012', 'AUTH-013', 'AUTH-014',
      ]),
    ),
  )

  await waitForAuthValid01BucketRefill('AUTH-001~004,010,020~024')

  steps.push(
    await runStep('SESS-001~003,006,007 (+004/005 조건부) (k6 session-flow)', () =>
      runK6Scenario('api/scenarios/session-flow.js', 'SESS', [
        'SESS-001', 'SESS-002', 'SESS-003', 'SESS-006', 'SESS-007', 'SESS-004', 'SESS-005',
      ]),
    ),
  )

  // QUEUE-001/002, CATALOG-001~003(배포 Frontend–Backend 종단 검증.md §10)도 AUTH_VALID_01로 로그인
  // 1회씩만 쓴다. RUN_DESTRUCTIVE_CATALOG_TESTS가 꺼져 있으면 session-flow.js 직후(위 대기로 방금
  // 5로 채운 Bucket에서 session-flow가 3을 이미 썼으니 남은 건 2)에 그대로 이어 붙여
  // 3+1+1=5로 끝난다.
  //
  // RUN_DESTRUCTIVE_CATALOG_TESTS=true이면 같은 catalog-connectivity.js 안의 Tier B가
  // AUTH_ROLE_OWNER_01로 1회 더 로그인한다. 2026-08-26 결정으로 AUTH_VALID_01과
  // AUTH_ROLE_OWNER_01은 같은 물리 계정이므로 Bucket도 공유한다. 이때는 3+1+1+1=6이 되어 Tier B
  // 로그인이 429로 실패할 수 있으므로 QUEUE 단계 뒤에서 조건부로 5분을 대기한 다음 Catalog의
  // Tier A/B 로그인 2회를 실행한다. 아래 Catalog 뒤의 기존 5분 대기는 Audit 로그인 전에 다시
  // Bucket을 채우므로 그대로 유지한다.
  // QUEUE-003(Tier B, 상태 변경)은 caseIds에 넣지 않는다 — RUN_DESTRUCTIVE_QUEUE_TESTS=true가 없는
  // 이 필수 게이트에서는 항상 SKIP_PRECONDITION이라, AUTH-011~015 중 AUTH-015를 뺀 것과 같은 이유로
  // 뺐다(mandatoryApiPassed는 "전부 PASS"를 요구해 SKIP도 실패로 치기 때문). QUEUE-003 자체 결과는
  // 이 단계가 만드는 results.jsonl/junit.xml에 그대로 기록된다 — 필수 통과 판정에서만 빠진다.
  steps.push(
    await runStep('QUEUE-001~002 (k6 queue-connectivity)', () =>
      runK6Scenario('api/scenarios/queue-connectivity.js', 'QUEUE', ['QUEUE-001', 'QUEUE-002']),
    ),
  )

  if (process.env.RUN_DESTRUCTIVE_CATALOG_TESTS === 'true') {
    await waitForAuthValid01BucketRefill('SESS-001~007 및 QUEUE-001~003')
  }

  steps.push(
    await runStep('CATALOG-001~003 (k6 catalog-connectivity)', () =>
      runK6Scenario('api/scenarios/catalog-connectivity.js', 'CATALOG', [
        'CATALOG-001', 'CATALOG-002', 'CATALOG-003',
      ]),
    ),
  )

  // AUDIT-001, SALES-001(배포 Frontend–Backend 종단 검증.md §10)은 audit-sales-connectivity.js가
  // 별도 k6 프로세스라 자기 자신의 AUTH_VALID_01 로그인이 1회 더 필요하다(프로세스 간 Cookie Jar
  // 공유 불가 — audit-sales-connectivity.js 파일 상단 주석 참고). 파괴적 Catalog 플래그가 꺼졌으면
  // 바로 위 단계까지 3+1+1=5를 정확히 다 쓴 상태이고, 켜졌으면 조건부 대기 뒤 Catalog의 Tier A/B가
  // 2를 쓴 상태다. 어느 경우든 여기서 5분을 대기해 Bucket을 다시 5로 채운 뒤 이 새 단계가 1만 쓰고
  // 끝나는 것으로 예산 계산을 리셋한다. 이 단계 뒤에 다시 공유 계정을 쓰는 단계를 추가하려면
  // 이 주석과 api/README.md의 "⚠️ 계정 Rate Limit Bucket 주의" 표를 함께 갱신할 것.
  await waitForAuthValid01BucketRefill('CATALOG-001~003')

  steps.push(
    // SALES-001은 mandatoryIds에서 뺐다 — audit-sales-connectivity.js의 isNearKstMidnight()가
    // KST 자정 전후 5분 이내 실행이면 이 케이스를 SKIP_PRECONDITION으로 처리한다(하루 약 0.7%
    // 구간). mandatoryApiPassed는 "전부 PASS"를 요구해 SKIP도 실패로 치므로, mandatoryIds에
    // 넣어두면 이 좁은 시간대에 게이트를 돌렸다는 이유만으로 종합 판정이 실패한다 — AUTH-015를
    // 뺀 것과 같은 이유(위 55~62행 참고)다. AUDIT-001은 이런 타이밍 의존성이 없어 그대로
    // mandatoryIds에 남긴다. SALES-001 자체 결과는 그대로 실행·기록되며(results.jsonl/junit.xml),
    // 필수 통과 판정에서만 빠진다.
    await runStep('AUDIT-001, SALES-001 (k6 audit-sales-connectivity)', () =>
      runK6Scenario('api/scenarios/audit-sales-connectivity.js', 'AUDIT-SALES', [
        'AUDIT-001',
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
