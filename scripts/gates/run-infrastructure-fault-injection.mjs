#!/usr/bin/env node
// 인프라 장애 주입 전용 실행기. --scope=local은 Docker만, --scope=eks는 EKS만 변경한다.
// EKS 경로는 메뉴의 y 확인 후 전달되는 --confirmed 없이는 실행하지 않는다.
import { pathToFileURL } from 'node:url'
import { printFinalSummary, runNodeScript, runPlaywrightSpec, runStep } from '../lib/gate-steps.mjs'

function parseScope(args) {
  const scope = args.find((arg) => arg.startsWith('--scope='))?.slice('--scope='.length)
  if (scope !== 'local' && scope !== 'eks') throw new Error('사용법: --scope=local 또는 --scope=eks')
  return scope
}

export async function runInfrastructureFaultInjection(scope) {
  const steps = []
  if (scope === 'local') {
    console.log('모드: 인프라 장애 주입 커버리지 (로컬 Docker)')
    for (const opsId of ['OPS-001', 'OPS-003']) {
      steps.push(await runStep(`${opsId} (로컬 Docker 장애 주입)`, () =>
        runNodeScript('scripts/local-rehearsal/run-fault-injection.mjs', [opsId, '--confirm']),
      ))
    }
    return steps
  }

  if ((process.env.DORO_ENVIRONMENT ?? '').startsWith('local')) {
    throw new Error('EKS 장애 주입은 DORO_ENVIRONMENT가 local인 상태에서 실행할 수 없습니다.')
  }
  console.log('모드: 인프라 장애 주입 커버리지 (배포 EKS)')
  process.env.RUN_FAULT_INJECTION_TESTS = 'true'
  steps.push(await runStep('FE-BE-012 (EKS Provider 장애 주입)', () =>
    runPlaywrightSpec('tests/fe-be-conditional.spec.ts', ['--grep', 'FE-BE-012']),
  ))
  steps.push(await runStep('OPS-002 (EKS Service selector 디코이 전환)', () =>
    runNodeScript('scripts/gates/verify-provider-malformed-response.mjs', ['--confirm']),
  ))
  steps.push(await runStep('OPS-005 (EKS Pod 일부 장애)', () =>
    runNodeScript('scripts/gates/verify-partial-pod-failure.mjs', ['--confirm']),
  ))
  return steps
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const scope = parseScope(process.argv.slice(2))
    if (scope === 'eks' && !process.argv.includes('--confirmed')) {
      throw new Error('EKS 장애 주입은 사용자 메뉴에서 경고를 확인한 뒤 --confirmed로만 실행할 수 있습니다.')
    }
    const steps = await runInfrastructureFaultInjection(scope)
    process.exit(printFinalSummary(steps) ? 0 : 1)
  } catch (error) {
    console.error('ERROR: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(2)
  }
}
