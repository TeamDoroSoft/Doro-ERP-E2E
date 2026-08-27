import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { DeployEnv } from './env'
import { reportPath } from './resultLogger'

// FE-BE-022(일별 매출 조회)는 fe-be-mandatory.spec.ts에서 항상 실행되지만 이 목록에는 넣지
// 않는다 — AUTH-015/SALES-001을 run-mandatory-gate.mjs의 mandatoryIds에서 뺀 것과 같은 이유로,
// AUTH_ROLE_MANAGER_01/OWNER_01 정적 계정 부재(SKIP_PRECONDITION) 또는 KST 자정 경계 회피
// (마찬가지로 SKIP_PRECONDITION)가 실제 결함이 아닌데도 mandatoryBrowserPassed 전체를 실패로
// 만들면 안 되기 때문이다(mandatoryBrowserPassed는 "전부 PASS"를 요구해 SKIP도 실패로 친다).
// FE-BE-022 자체 결과는 그대로 실행·기록되며, 이 좁은 판정에서만 빠진다.
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
