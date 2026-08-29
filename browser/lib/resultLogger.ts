import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DeployEnv } from './env'

export type ResultCode =
  | 'PASS'
  | 'FAIL_ASSERTION'
  | 'FAIL_UI'
  | 'FAIL_NETWORK_MAPPING'
  | 'FAIL_PROTECTED_FLOW'
  | 'ERROR_TRANSPORT'
  | 'ERROR_CONFIG'
  | 'SKIP_PRECONDITION'
  | 'ABORT_SAFETY'

export interface CaseExpected {
  startPath?: string
  requestPath?: string
  httpStatus?: number
  finalPath?: string
  protectedApiStatus?: number
}

export interface CaseObserved {
  startPath?: string
  requestMethod?: string
  requestPath?: string
  httpStatus?: number
  loginStatus?: number
  finalPath?: string
  protectedApiPath?: string
  protectedApiStatus?: number
  protectedApiRequestSent?: boolean
}

export interface BrowserObservation {
  consoleErrorCount: number
  // 오류 원문은 민감정보를 제거한 뒤, 원인 추적이 필요한 케이스에만 선택적으로 기록한다.
  consoleErrors?: string[]
  // 같은 Origin의 4xx/5xx 경로만 기록한다. Query·Host·응답 Body는 기록하지 않는다.
  httpErrorPaths?: string[]
  pageErrorCount: number
  failedRequiredRequestCount: number
}

export interface CaseResultInput {
  testCaseId: string
  testCaseAttempt?: number
  accountAlias?: string
  resultCode: ResultCode
  startedAt: string
  durationMs: number
  expected?: CaseExpected
  observed?: CaseObserved
  requestId?: string
  assertions?: Record<string, boolean>
  browser?: BrowserObservation
  failureScreenshot?: string | null
  errorClass?: string | null
}

// browser/lib/에서 두 단계 위가 doro-erp-e2e/reports/ — playwright test가 어느 CWD에서
// 실행되든 항상 같은 위치를 가리키도록 CWD가 아니라 이 파일 위치를 기준으로 계산한다.
const reportsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports')

export function reportPath(runId: string): string {
  return resolve(reportsRoot, runId, 'results.jsonl')
}

export function appendCaseResult(runId: string, env: DeployEnv, input: CaseResultInput): void {
  const record = {
    schemaVersion: 1,
    runId,
    testCaseId: input.testCaseId,
    testCaseAttempt: input.testCaseAttempt ?? 1,
    layer: 'FRONTEND_E2E',
    resultCode: input.resultCode,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    environment: env.environment,
    targetHost: new URL(env.frontendOrigin).host,
    deployment: env.deployment,
    accountAlias: input.accountAlias ?? null,
    expected: input.expected ?? {},
    observed: input.observed ?? {},
    requestId: input.requestId ?? null,
    assertions: input.assertions ?? {},
    browser: input.browser ?? { consoleErrorCount: 0, pageErrorCount: 0, failedRequiredRequestCount: 0 },
    artifacts: { failureScreenshot: input.failureScreenshot ?? null },
    errorClass: input.errorClass ?? null,
  }
  const path = reportPath(runId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}
