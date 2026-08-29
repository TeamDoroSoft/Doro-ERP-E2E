#!/usr/bin/env node
// 레거시 내부 실행기 — 필수 게이트(run-mandatory-gate.mjs) 전부와 도메인 상태변경
// 시나리오를 실행한다. 인프라 장애 주입(FE-BE-012, OPS-001~003, OPS-005)은
// run-infrastructure-fault-injection.mjs로 분리되어 이 파일에서는 실행하지 않는다.
//
// AUTH-015 → AUTH-030 순서 의존성: runMandatoryGate()가 먼저 실행하는
// api/scenarios/auth-scenarios(-account-nonexposure).js의 AUTH-015는 RUN_DESTRUCTIVE_AUTH_TESTS=true일 때
// AUTH_LOCKOUT_01 계정에 틀린 비밀번호 5회 + 맞는 비밀번호 1회(총 6회)를 보내 로그인 Rate Limit
// Bucket(용량 5, 분당 1 리필)을 완전히 소진시킨다. 바로 뒤이어 실행되는 이 파일의
// AUTH-030,031,033 단계는 api/scenarios/auth-lockout-ratelimit.js를 호출하는데, 그중
// AUTH-030은 같은 AUTH_LOCKOUT_01 계정에 틀린 비밀번호 5회를 보내고 다섯 응답 전부가 정확히
// 401이어야 한다고 단언한다(AUTH-031/033은 401 또는 429를 모두 허용해 영향받지 않음).
// AUTH-015 직후라 Bucket이 아직 비어 있으면 AUTH-030의 초반 요청이 401 대신 429를 받아
// 실제 제품 결함이 아닌 순전한 실행 순서 때문에 FAIL_ASSERTION이 발생한다. 이를 막기 위해
// AUTH-030,031,033 단계 직전에 RUN_DESTRUCTIVE_AUTH_TESTS=true일 때만(그 값이 아니면
// AUTH-015도 파괴적으로 실행되지 않았고 이 단계도 자체 SKIP되므로 대기가 무의미하다) Bucket이
// 다시 채워질 만큼(약 65초, 과거 실행 관찰 기준) 그대로 대기한다.
//
// QUEUE-003(배포 Frontend–Backend 종단 검증.md §10 Tier B)도 AUTH-015와 같은 구조다 —
// api/scenarios/queue-connectivity.js 한 파일 안에 QUEUE-001/002(Tier A, 상시 실행)와
// QUEUE-003(Tier B, RUN_DESTRUCTIVE_QUEUE_TESTS=true일 때만 실행)이 같이 있고, 이 파일은
// run-mandatory-gate.mjs의 "QUEUE-001~002 (k6 queue-connectivity)" 단계에서 이미 호출된다
// (runFullGate()가 그 run-mandatory-gate.mjs를 먼저 통째로 실행하므로). 그래서 이 파일은
// AUTH-030처럼 별도 시나리오 파일·별도 runK6Scenario 호출을 새로 두지 않는다 — 그렇게 하면
// QUEUE-001/002 로그인과 QUEUE-003 등록·취소가 중복 실행되어 AUTH_VALID_01 Bucket을 불필요하게
// 더 쓰고, 실 테넌트에 취소된 Entry가 한 번 더 남는다. 대신 아래 "QUEUE-003" 단계는 안내만 출력한다.
// 같은 RUN_DESTRUCTIVE_QUEUE_TESTS 플래그를 FE-BE-023(대기열 접수 화면, tests/fe-be-conditional.spec.ts)도
// 그대로 읽는다 — 그 케이스는 k6가 아니라 아래 "FE-BE-010~015,020,021,023~027" Playwright 단계 안에서
// 함께 돈다(별도 안내 불필요 — 그 단계가 이미 guardFlag로 이 플래그 상태를 출력한다).
//
// CATALOG-004~006(§10 Tier B)도 정확히 같은 구조·같은 이유다 — api/scenarios/catalog-connectivity.js
// 한 파일 안에 CATALOG-001~003(Tier A)과 CATALOG-004~006(Tier B, RUN_DESTRUCTIVE_CATALOG_TESTS=true일
// 때만 실행)이 같이 있고, 이 파일은 run-mandatory-gate.mjs의 "CATALOG-001~003 (k6 catalog-connectivity)"
// 단계에서 이미 호출된다. 여기서 별도 runK6Scenario를 또 호출하면 CATALOG-001~003 조회와
// CATALOG-004~006의 Category·Product 생성·수정이 중복 실행되어 실 테넌트(e2e-auth-active)에
// 겹치는 이름의 Category·Product가 한 번 더 영구히 남는다. 아래 "CATALOG-004~006" 단계도 안내만
// 출력한다. 2026-08-26부터 AUTH_VALID_01과 AUTH_ROLE_OWNER_01은 같은 물리 계정과 Rate Limit
// Bucket을 공유한다. runMandatoryGate()는 이 플래그가 켜졌을 때 QUEUE 단계 뒤에서 5분을 추가로
// 기다린 뒤 Catalog의 Tier A 로그인 1회와 Tier B 로그인 1회를 실행한다. 같은 RUN_DESTRUCTIVE_CATALOG_TESTS
// 플래그를 FE-BE-025(카탈로그 등록/수정 화면)도 그대로 읽는다 — QUEUE-003/FE-BE-023과 같은 이유로
// Playwright 조건부 시나리오 단계 안에서 함께 돈다.
import { pathToFileURL } from 'node:url'
import { runMandatoryGate } from './run-mandatory-gate.mjs'
import {
  ensureRunId,
  runStep,
  guardFlag,
  runPlaywrightSpec,
  runK6Scenario,
  runNodeScript,
  printFinalSummary,
  waitForRateLimitRecovery,
} from '../lib/gate-steps.mjs'

const ACCOUNT_BUCKET_REFILL_MS = 60_000
const ACCOUNT_BUCKET_SAFETY_MARGIN_MS = 30_000

async function waitForSharedAccountBudget(label, currentTokens, requiredTokens, nextStepName) {
  const missingTokens = Math.max(0, requiredTokens - currentTokens)
  if (missingTokens === 0) return

  const waitMs = missingTokens * ACCOUNT_BUCKET_REFILL_MS + ACCOUNT_BUCKET_SAFETY_MARGIN_MS
  await waitForRateLimitRecovery({
    label: `${label}: 공유 AUTH_VALID_01/AUTH_ROLE_OWNER_01 버킷 ${missingTokens}개 토큰 회복 필요`,
    waitMs,
    nextStep: nextStepName,
  })
}

function conditionalGroupSharedLoginBudget() {
  const orderEnabled = process.env.RUN_DESTRUCTIVE_ORDER_TESTS === 'true'
  const queueEnabled = process.env.RUN_DESTRUCTIVE_QUEUE_TESTS === 'true'
  const catalogEnabled = process.env.RUN_DESTRUCTIVE_CATALOG_TESTS === 'true'
  return {
    // FE-BE-014(OWNER) 1회 + FE-BE-015 안전/비안전 redirect 2회 + 주문 020/021 각 1회.
    groupA: 3 + (orderEnabled ? 2 : 0),
    // FE-BE-023 1회 + FE-BE-024 1회 + FE-BE-025(OWNER) 1회.
    groupB: (queueEnabled ? 1 : 0) + (orderEnabled ? 1 : 0) + (catalogEnabled ? 1 : 0),
  }
}

export async function runFullGate() {
  const runId = ensureRunId()
  const steps = await runMandatoryGate({ includeSummary: false })

  steps.push(
    await runStep('QUEUE-003 (k6 queue-connectivity, RUN_DESTRUCTIVE_QUEUE_TESTS 필요)', () => {
      if (process.env.RUN_DESTRUCTIVE_QUEUE_TESTS !== 'true') {
        guardFlag(
          'RUN_DESTRUCTIVE_QUEUE_TESTS',
          'QUEUE-003(Entry 등록→취소 상태 변경)',
          'RUN_DESTRUCTIVE_QUEUE_TESTS=true를 export한 뒤 처음부터(run-mandatory-gate.mjs 단계 포함) 다시 실행하세요.',
        )
        return { ok: true, skipped: true }
      }
      console.log(
        '  ℹ QUEUE-003은 여기서 별도로 실행하지 않습니다 — 위 runMandatoryGate()의 ' +
          '"QUEUE-001~002 (k6 queue-connectivity)" 단계 안에서 같은 k6 파일(api/scenarios/queue-connectivity.js)이 ' +
          '이 플래그를 직접 읽어 이미 함께 실행·기록했습니다. 결과는 그 단계가 만든 ' +
          'reports/<runId>/QUEUE.results.jsonl에서 QUEUE-003 항목으로 확인하세요.',
      )
      return { ok: true, skipped: false }
    }),
  )

  steps.push(
    await runStep('CATALOG-004~006 (k6 catalog-connectivity, RUN_DESTRUCTIVE_CATALOG_TESTS 필요)', () => {
      if (process.env.RUN_DESTRUCTIVE_CATALOG_TESTS !== 'true') {
        guardFlag(
          'RUN_DESTRUCTIVE_CATALOG_TESTS',
          'CATALOG-004~006(Category·Product 생성·수정·품절 전환)',
          'RUN_DESTRUCTIVE_CATALOG_TESTS=true를 export한 뒤 처음부터(run-mandatory-gate.mjs 단계 포함) 다시 실행하세요.',
        )
        return { ok: true, skipped: true }
      }
      console.log(
        '  ℹ CATALOG-004~006은 여기서 별도로 실행하지 않습니다 — 위 runMandatoryGate()의 ' +
          '"CATALOG-001~003 (k6 catalog-connectivity)" 단계 안에서 같은 k6 파일(api/scenarios/catalog-connectivity.js)이 ' +
          '이 플래그를 직접 읽어 이미 함께 실행·기록했습니다. 결과는 그 단계가 만든 ' +
          'reports/<runId>/CATALOG.results.jsonl에서 CATALOG-004~006 항목으로 확인하세요.',
      )
      return { ok: true, skipped: false }
    }),
  )

  const conditionalBudget = conditionalGroupSharedLoginBudget()
  // runMandatoryGate 마지막 AUDIT-SALES 단계가 공유 계정 로그인 1회를 사용하므로, 직전의 5분
  // 회복 직후에도 추정 잔량은 4개다. 외부 동시 실행은 사용자용 진입점의 실행 락으로 차단한다.
  let sharedAccountTokens = 4
  await waitForSharedAccountBudget(
    '조건부 그룹 A 시작 전',
    sharedAccountTokens,
    conditionalBudget.groupA,
    'FE-BE-010~015,020,021',
  )
  sharedAccountTokens = Math.max(sharedAccountTokens, conditionalBudget.groupA) - conditionalBudget.groupA

  steps.push(
    await runStep('FE-BE-010~015,020,021 (Playwright 조건부 그룹 A)', () => {
      guardFlag(
        'RUN_FAULT_INJECTION_TESTS',
        'FE-BE-012(Provider 장애 주입)',
        'RUN_FAULT_INJECTION_TESTS=true를 export한 뒤 다시 실행하세요 (나머지 FE-BE-010/011/013/014/015는 이 플래그와 무관하게 각자 Fixture 유무로 실행/SKIP됩니다).',
      )
      // FE-BE-020(주문 생성·화면 취소)/021(결제 시작)/024(PENDING 결제 복구)도 같은
      // 파일(tests/fe-be-conditional.spec.ts) 안에 있다 —
      // 주문 취소 API가 소프트 취소라 order_status_history에 생성·취소 이력이 영구히 남기 때문에
      // (QUEUE-003/CATALOG-004~006과 같은 이유) 이 플래그 없이는 SKIP_PRECONDITION으로 끝난다.
      guardFlag(
        'RUN_DESTRUCTIVE_ORDER_TESTS',
        'FE-BE-020/021/024(주문 생성·결제 시작·PENDING 복구)',
        'RUN_DESTRUCTIVE_ORDER_TESTS=true를 export한 뒤 다시 실행하세요.',
      )
      return runPlaywrightSpec('tests/fe-be-conditional.spec.ts', [
        '--grep',
        'FE-BE-(010|011|012|013|014|015|020|021)',
      ])
    }),
  )

  await waitForSharedAccountBudget(
    '조건부 그룹 B 시작 전',
    sharedAccountTokens,
    conditionalBudget.groupB,
    'FE-BE-023~027 (FE-BE-025 포함)',
  )

  steps.push(
    await runStep('FE-BE-023~027 (Playwright 조건부 그룹 B)', () => {
      guardFlag(
        'RUN_DESTRUCTIVE_QUEUE_TESTS',
        'FE-BE-023(대기열 접수 화면)',
        'RUN_DESTRUCTIVE_QUEUE_TESTS=true를 export한 뒤 다시 실행하세요.',
      )
      guardFlag(
        'RUN_DESTRUCTIVE_CATALOG_TESTS',
        'FE-BE-025(카탈로그 등록/수정 화면)',
        'RUN_DESTRUCTIVE_CATALOG_TESTS=true를 export한 뒤 다시 실행하세요.',
      )
      return runPlaywrightSpec('tests/fe-be-conditional.spec.ts', ['--grep', 'FE-BE-(023|024|025|026|027)'])
    }),
  )

  if (process.env.RUN_DESTRUCTIVE_AUTH_TESTS === 'true') {
    await waitForRateLimitRecovery({
      label: 'AUTH-015 이후 AUTH_LOCKOUT_01 버킷',
      waitMs: 65_000,
      nextStep: 'AUTH-030,031,033',
    })
  }

  steps.push(
    await runStep('AUTH-030,031,033 (k6 잠금·계정 Rate Limit)', () => {
      guardFlag(
        'RUN_DESTRUCTIVE_AUTH_TESTS',
        'AUTH-030/031/033 전체',
        'RUN_DESTRUCTIVE_AUTH_TESTS=true를 export한 뒤 다시 실행하세요.',
      )
      return runK6Scenario('api/scenarios/auth-lockout-ratelimit.js', 'AUTH-lockout', [
        'AUTH-030', 'AUTH-031', 'AUTH-033',
      ])
    }),
  )

  steps.push(
    await runStep('종합 판정 (build-combined-summary)', () =>
      runNodeScript('scripts/reporting/build-combined-summary.mjs', [runId]),
    ),
  )

  return steps
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const steps = await runFullGate()
  const allOk = printFinalSummary(steps)
  process.exit(allOk ? 0 : 1)
}
