#!/usr/bin/env node
// 전체 게이트 — 필수 게이트(run-mandatory-gate.mjs) 전부 + 조건부/파괴적 시나리오
// (배포 Frontend–Backend 종단 검증.md §4 조건부 Browser, §5의 AUTH-030~035·OPS-002, §6의
// OPS-005, §10의 QUEUE-003·CATALOG-004~006)까지 한 번에 실행한다.
//
// 파괴적 플래그(RUN_DESTRUCTIVE_AUTH_TESTS, RUN_FAULT_INJECTION_TESTS)는 이 스크립트가 절대
// 대신 켜주지 않는다 — 실행하는 사람이 이 명령을 돌리기 "전에" 직접 export해야만 해당
// 케이스가 실제로 실행된다. 안 켜져 있으면 관련 단계를 건너뛰고 무엇을 export해야 켜지는지
// 안내만 출력한다. FE-BE-012·AUTH-030/031/033/034는 각 파일 안의 기존 안전장치가 그대로
// 처리한다(설정 안 돼 있으면 파일 자체가 SKIP_PRECONDITION으로 기록) — AUTH-030/031은 이
// 플래그와 별개로 AUTH_LOCKOUT_01 정적 계정이 없어도 같은 방식으로 SKIP된다. OPS-001/002/003/005는
// 개별 스크립트가 `--confirm` CLI 인자를 직접 요구하는 구조라 이 오케스트레이터가 대신
// 판단해야 하는데, 새 플래그를 따로 만들지 않고 FE-BE-012와 같은 위험 범주(실제로 무언가를
// 멈추거나 지우거나 바꾼다)이므로 RUN_FAULT_INJECTION_TESTS 하나를 그대로 재사용한다 — 켜져
// 있을 때만 `--confirm`을 붙여서 호출하고, 아니면 아예 호출하지 않고 SKIP으로 기록한다.
//
// AUTH-015 → AUTH-030 순서 의존성: runMandatoryGate()가 먼저 실행하는
// api/scenarios/auth-scenarios(-account-nonexposure).js의 AUTH-015는 RUN_DESTRUCTIVE_AUTH_TESTS=true일 때
// AUTH_LOCKOUT_01 계정에 틀린 비밀번호 5회 + 맞는 비밀번호 1회(총 6회)를 보내 로그인 Rate Limit
// Bucket(용량 5, 분당 1 리필)을 완전히 소진시킨다. 바로 뒤이어 실행되는 이 파일의
// AUTH-030,031,033,034 단계는 api/scenarios/auth-lockout-ratelimit.js를 호출하는데, 그중
// AUTH-030은 같은 AUTH_LOCKOUT_01 계정에 틀린 비밀번호 5회를 보내고 다섯 응답 전부가 정확히
// 401이어야 한다고 단언한다(AUTH-031/033/034는 401 또는 429를 모두 허용해 영향받지 않음).
// AUTH-015 직후라 Bucket이 아직 비어 있으면 AUTH-030의 초반 요청이 401 대신 429를 받아
// 실제 제품 결함이 아닌 순전한 실행 순서 때문에 FAIL_ASSERTION이 발생한다. 이를 막기 위해
// AUTH-030,031,033,034 단계 직전에 RUN_DESTRUCTIVE_AUTH_TESTS=true일 때만(그 값이 아니면
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
//
// CATALOG-004~006(§10 Tier B)도 정확히 같은 구조·같은 이유다 — api/scenarios/catalog-connectivity.js
// 한 파일 안에 CATALOG-001~003(Tier A)과 CATALOG-004~006(Tier B, RUN_DESTRUCTIVE_CATALOG_TESTS=true일
// 때만 실행)이 같이 있고, 이 파일은 run-mandatory-gate.mjs의 "CATALOG-001~003 (k6 catalog-connectivity)"
// 단계에서 이미 호출된다. 여기서 별도 runK6Scenario를 또 호출하면 CATALOG-001~003 조회와
// CATALOG-004~006의 Category·Product 생성·수정이 중복 실행되어 실 테넌트(e2e-auth-active)에
// 겹치는 이름의 Category·Product가 한 번 더 영구히 남는다. 아래 "CATALOG-004~006" 단계도 안내만
// 출력한다. 2026-08-26부터 AUTH_VALID_01과 AUTH_ROLE_OWNER_01은 같은 물리 계정과 Rate Limit
// Bucket을 공유한다. runMandatoryGate()는 이 플래그가 켜졌을 때 QUEUE 단계 뒤에서 5분을 추가로
// 기다린 뒤 Catalog의 Tier A 로그인 1회와 Tier B 로그인 1회를 실행한다.
import { pathToFileURL } from 'node:url'
import { runMandatoryGate } from './run-mandatory-gate.mjs'
import { runStep, guardFlag, runPlaywrightSpec, runK6Scenario, runNodeScript, printFinalSummary } from './lib/gate-steps.mjs'

export async function runFullGate() {
  const steps = await runMandatoryGate()

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

  steps.push(
    await runStep('FE-BE-010~015,020,021 (Playwright 조건부 시나리오)', () => {
      guardFlag(
        'RUN_FAULT_INJECTION_TESTS',
        'FE-BE-012(Provider 장애 주입)',
        'RUN_FAULT_INJECTION_TESTS=true를 export한 뒤 다시 실행하세요 (나머지 FE-BE-010/011/013/014/015는 이 플래그와 무관하게 각자 Fixture 유무로 실행/SKIP됩니다).',
      )
      // FE-BE-020(주문 생성)/021(결제 시작)도 같은 파일(tests/fe-be-conditional.spec.ts) 안에 있다 —
      // 주문 취소 API가 소프트 취소라 order_status_history에 생성·취소 이력이 영구히 남기 때문에
      // (QUEUE-003/CATALOG-004~006과 같은 이유) 이 플래그 없이는 SKIP_PRECONDITION으로 끝난다.
      guardFlag(
        'RUN_DESTRUCTIVE_ORDER_TESTS',
        'FE-BE-020/021(주문 생성·결제 시작)',
        'RUN_DESTRUCTIVE_ORDER_TESTS=true를 export한 뒤 다시 실행하세요.',
      )
      return runPlaywrightSpec('tests/fe-be-conditional.spec.ts')
    }),
  )

  if (process.env.RUN_DESTRUCTIVE_AUTH_TESTS === 'true') {
    console.log(
      '  ⏳ AUTH-015(방금 실행됨)가 AUTH_LOCKOUT_01의 Rate Limit Bucket을 소진시켰을 수 있습니다 — ' +
        'AUTH-030의 5회 연속 401 판정이 429로 오염되지 않도록 65초 대기합니다.',
    )
    await new Promise((r) => setTimeout(r, 65_000))
  }

  steps.push(
    await runStep('AUTH-030,031,033,034 (k6 잠금·Rate Limit)', () => {
      guardFlag(
        'RUN_DESTRUCTIVE_AUTH_TESTS',
        'AUTH-030/031/033/034 전체',
        'RUN_DESTRUCTIVE_AUTH_TESTS=true를 export한 뒤 다시 실행하세요.',
      )
      return runK6Scenario('api/scenarios/auth-lockout-ratelimit.js', 'AUTH-lockout', [
        'AUTH-030', 'AUTH-031', 'AUTH-033', 'AUTH-034',
      ])
    }),
  )

  const isLocalRehearsal = (process.env.DORO_ENVIRONMENT ?? '').startsWith('local')

  for (const opsId of ['OPS-001', 'OPS-003']) {
    steps.push(
      await runStep(`${opsId} (로컬 Docker 장애 주입)`, () => {
        if (!isLocalRehearsal) {
          console.log(`  ⚠ DORO_ENVIRONMENT가 로컬 리허설 대상이 아닙니다 — ${opsId}를 이번 실행에서 SKIP합니다.`)
          console.log(
            '    scripts/run-fault-injection.mjs는 로컬 Docker 주소와 컨테이너 이름에 하드코딩되어 실제 배포를 대상으로 실행할 수 없습니다. ' +
              '잘못된 대상을 검증하지 않도록 이 단계를 건너뜁니다.',
          )
          return { ok: true, skipped: true }
        }
        if (process.env.RUN_FAULT_INJECTION_TESTS !== 'true') {
          guardFlag(
            'RUN_FAULT_INJECTION_TESTS',
            `${opsId}(실제로 컨테이너를 멈췄다 올림)`,
            `RUN_FAULT_INJECTION_TESTS=true를 export한 뒤 다시 실행하세요 — 이 스크립트는 그 값이 있을 때만 --confirm을 붙여서 호출됩니다.`,
          )
          return { ok: true, skipped: true }
        }
        return runNodeScript('scripts/run-fault-injection.mjs', [opsId, '--confirm'])
      }),
    )
  }

  steps.push(
    await runStep('OPS-002 (실 배포 EKS Provider 미승인 응답, 미검증)', () => {
      if (isLocalRehearsal) {
        console.log('  ⚠ DORO_ENVIRONMENT가 로컬 리허설 대상입니다 — OPS-002를 이번 실행에서 SKIP합니다.')
        console.log(
          '    scripts/verify-provider-malformed-response.mjs는 kubectl로 실 EKS의 store-access-api Service를 ' +
            '건드리는 실 배포 전용 스크립트라 로컬 리허설 대상에는 실행할 이유가 없습니다.',
        )
        return { ok: true, skipped: true }
      }
      if (process.env.RUN_FAULT_INJECTION_TESTS !== 'true') {
        guardFlag(
          'RUN_FAULT_INJECTION_TESTS',
          'OPS-002(실제로 store-access-api Service selector를 디코이로 임시 교체)',
          'RUN_FAULT_INJECTION_TESTS=true를 export한 뒤 다시 실행하세요 — 이 스크립트는 그 값이 있을 때만 --confirm을 붙여서 호출됩니다. ' +
            '단, 이 세션 기준 EKS Access Entry가 없어 이 단계는 켜도 실패할 가능성이 높습니다(project_eks_access_terraform_role 메모 참고). ' +
            '켜져 있는 동안 store-access-api를 쓰는 edge-api의 모든 통신이 함께 영향받는다는 점도 스크립트 상단 주석 참고.',
        )
        return { ok: true, skipped: true }
      }
      return runNodeScript('scripts/verify-provider-malformed-response.mjs', ['--confirm'])
    }),
  )

  steps.push(
    await runStep('OPS-005 (실 배포 EKS 일부 Pod 비정상, 미검증)', () => {
      if (isLocalRehearsal) {
        console.log('  ⚠ DORO_ENVIRONMENT가 로컬 리허설 대상입니다 — OPS-005를 이번 실행에서 SKIP합니다.')
        console.log(
          '    scripts/verify-partial-pod-failure.mjs는 kubectl로 실 EKS의 store-access-api Pod를 ' +
            'delete하는 실 배포 전용 스크립트라 로컬 리허설 대상에는 실행할 이유가 없습니다.',
        )
        return { ok: true, skipped: true }
      }
      if (process.env.RUN_FAULT_INJECTION_TESTS !== 'true') {
        guardFlag(
          'RUN_FAULT_INJECTION_TESTS',
          'OPS-005(실제로 store-access-api Pod 1개를 delete)',
          'RUN_FAULT_INJECTION_TESTS=true를 export한 뒤 다시 실행하세요 — 이 스크립트는 그 값이 있을 때만 --confirm을 붙여서 호출됩니다. ' +
            '단, 이 세션 기준 EKS Access Entry가 없어 이 단계는 켜도 실패할 가능성이 높습니다(project_eks_access_terraform_role 메모 참고).',
        )
        return { ok: true, skipped: true }
      }
      return runNodeScript('scripts/verify-partial-pod-failure.mjs', ['--confirm'])
    }),
  )

  return steps
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const steps = await runFullGate()
  const allOk = printFinalSummary(steps)
  process.exit(allOk ? 0 : 1)
}
