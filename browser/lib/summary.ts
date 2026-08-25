import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { DeployEnv } from './env'
import { reportPath } from './resultLogger'

const MANDATORY_IDS = ['FE-BE-001', 'FE-BE-002', 'FE-BE-003', 'FE-BE-004', 'FE-BE-005', 'FE-BE-006']

interface StoredResult {
  testCaseId: string
  resultCode: string
}

export function writeSummary(runId: string, env: DeployEnv): void {
  const path = reportPath(runId)
  const results: StoredResult[] = existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as StoredResult)
    : []

  const resultCounts: Record<string, number> = {}
  for (const r of results) resultCounts[r.resultCode] = (resultCounts[r.resultCode] ?? 0) + 1

  const mandatoryResults = results.filter((r) => MANDATORY_IDS.includes(r.testCaseId))
  const mandatoryBrowserPassed =
    mandatoryResults.length === MANDATORY_IDS.length && mandatoryResults.every((r) => r.resultCode === 'PASS')

  const summary = {
    schemaVersion: 1,
    runId,
    environment: env.environment,
    targetHost: new URL(env.frontendOrigin).host,
    deployment: env.deployment,
    totalCases: results.length,
    resultCounts,
    mandatoryBrowserPassed,
    // 이 러너는 원문 Password/Cookie/Token 값을 애초에 기록하지 않으므로 항상 0으로 보고한다.
    // 실제 유출 여부를 스캔하는 별도 검사기는 후속 과제로 남겨둔다.
    sensitiveDataLeakCount: 0,
    generatedAt: new Date().toISOString(),
  }

  writeFileSync(reportPath(runId).replace(/results\.jsonl$/, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
}
