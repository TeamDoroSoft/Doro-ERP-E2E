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

export async function runMandatoryGate() {
  const runId = ensureRunId()
  console.log(`필수 게이트 시작 (DORO_RUN_ID=${runId})`)

  const steps = []

  steps.push(
    await runStep('FE-BE-001~006 (Playwright 필수 Gate)', () => runPlaywrightSpec('tests/fe-be-mandatory.spec.ts')),
  )

  steps.push(
    await runStep('AUTH-001~004,010,020~024 (k6 auth-mandatory)', () =>
      runK6Scenario('api/scenarios/auth-mandatory.js', 'auth-mandatory', [
        'AUTH-001', 'AUTH-002', 'AUTH-003', 'AUTH-004',
        'AUTH-010', 'AUTH-020', 'AUTH-021', 'AUTH-022', 'AUTH-023', 'AUTH-024',
      ]),
    ),
  )

  steps.push(
    await runStep('AUTH-011~015 (k6 계정 존재 비노출)', () =>
      runK6Scenario('api/scenarios/auth-account-nonexposure.js', 'auth-account-nonexposure', [
        'AUTH-011', 'AUTH-012', 'AUTH-013', 'AUTH-014', 'AUTH-015',
      ]),
    ),
  )

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
