function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildSummaryJson(env, results, mandatoryIds) {
  const resultCounts = {}
  for (const r of results) resultCounts[r.resultCode] = (resultCounts[r.resultCode] || 0) + 1

  const mandatoryResults = results.filter((r) => mandatoryIds.includes(r.testCaseId))
  const mandatoryApiPassed =
    mandatoryResults.length === mandatoryIds.length && mandatoryResults.every((r) => r.resultCode === 'PASS')

  return {
    schemaVersion: 1,
    runId: env.runId,
    environment: env.environment,
    targetHost: env.apiOrigin.replace(/^https?:\/\//, ''),
    deployment: env.deployment,
    totalCases: results.length,
    resultCounts,
    mandatoryApiPassed,
    // 이 러너는 원문 Password/Cookie/Token 값을 애초에 수집하지 않으므로 항상 0으로 보고한다.
    // 실제 유출 여부를 스캔하는 별도 검사기는 아직 없다 — 후속 과제로 남긴다.
    sensitiveDataLeakCount: 0,
    generatedAt: new Date().toISOString(),
  }
}

export function buildJunitXml(results, suiteName) {
  const failures = results.filter((r) => r.resultCode !== 'PASS' && r.resultCode !== 'SKIP_PRECONDITION').length
  const skipped = results.filter((r) => r.resultCode === 'SKIP_PRECONDITION').length
  const cases = results
    .map((r) => {
      const name = xmlEscape(r.testCaseId)
      const time = (r.durationMs / 1000).toFixed(3)
      if (r.resultCode === 'PASS') return `    <testcase name="${name}" time="${time}" />`
      if (r.resultCode === 'SKIP_PRECONDITION')
        return `    <testcase name="${name}" time="${time}"><skipped message="${xmlEscape(r.errorClass || '')}" /></testcase>`
      return `    <testcase name="${name}" time="${time}"><failure message="${xmlEscape(r.resultCode)}">${xmlEscape(r.errorClass || '')}</failure></testcase>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xmlEscape(suiteName)}" tests="${results.length}" failures="${failures}" skipped="${skipped}">\n${cases}\n</testsuite>\n`
}

export function consoleSummary(results) {
  const lines = results.map((r) => `${r.resultCode === 'PASS' ? 'PASS' : 'FAIL'}  ${r.testCaseId}  (${r.resultCode})${r.errorClass ? ` — ${r.errorClass}` : ''}`)
  return `${lines.join('\n')}\n`
}

// 이 파일은 k6 전용 API를 쓰지 않는 순수 함수만 담는다 — k6 스크립트(goja 런타임)와
// api/lib/build-report.mjs(평범한 Node 스크립트) 양쪽에서 그대로 import해 재사용한다.
