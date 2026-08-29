#!/usr/bin/env node
// 필수 도메인 상태변경 커버리지의 비대화형 실행기다. EKS/Docker 장애 주입 플래그는
// 명시적으로 제거해 이 실행 경로가 인프라 리소스를 변경하지 않도록 보장한다.
import { pathToFileURL } from 'node:url'
import { runFullGate } from './run-full-gate.mjs'
import { printFinalSummary } from '../lib/gate-steps.mjs'

const REQUIRED_DOMAIN_FLAGS = [
  'RUN_DESTRUCTIVE_AUTH_TESTS',
  'RUN_DESTRUCTIVE_QUEUE_TESTS',
  'RUN_DESTRUCTIVE_CATALOG_TESTS',
  'RUN_DESTRUCTIVE_ORDER_TESTS',
]

export async function runRequiredGate() {
  for (const name of REQUIRED_DOMAIN_FLAGS) process.env[name] = 'true'
  delete process.env.RUN_FAULT_INJECTION_TESTS
  console.log('모드: 필수 도메인 상태변경 커버리지 (인프라 조작 없음)')
  return runFullGate()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const steps = await runRequiredGate()
  process.exit(printFinalSummary(steps) ? 0 : 1)
}
