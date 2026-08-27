#!/usr/bin/env node
// k6 handleSummary()는 VU가 실행되는 것과 별도의 격리된 JS VM 인스턴스에서 돈다 — VU가 쌓아둔
// 결과를 볼 수 없다(resultLogger.js 주석 참고, 로컬 리허설에서 실제로 재현·확인). 그래서
// summary.json/junit.xml은 k6 밖에서, 이 평범한 Node 스크립트로 만든다.
//
// 사용법:
//   k6 run --log-format=raw api/scenarios/auth-mandatory.js 2>&1 | tee /tmp/run.log
//   node api/lib/build-report.mjs /tmp/run.log auth-mandatory AUTH-001,AUTH-002,...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildSummaryJson, buildJunitXml } from './report.js'

const [, , logPath, suiteName, mandatoryIdsArg] = process.argv
if (!logPath || !suiteName) {
  console.error('사용법: node build-report.mjs <k6-raw-log-file> <suiteName> [mandatoryId1,mandatoryId2,...]')
  process.exit(2)
}
const mandatoryIds = mandatoryIdsArg ? mandatoryIdsArg.split(',') : []

const results = readFileSync(logPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('{'))
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter((entry) => entry && typeof entry.testCaseId === 'string' && typeof entry.resultCode === 'string')

if (results.length === 0) {
  console.error(
    `${logPath}에서 케이스 결과 줄(JSON, testCaseId 포함)을 하나도 못 찾았습니다. ` +
      'k6를 --log-format=raw로 실행했는지, 로그 파일이 맞는지 확인하세요.',
  )
  process.exit(1)
}

const first = results[0]
const env = {
  runId: first.runId,
  environment: first.environment,
  apiOrigin: first.targetHost,
  deployment: first.deployment,
}

const runDir = `reports/${env.runId}`
mkdirSync(runDir, { recursive: true })
const base = `${runDir}/${suiteName}`
writeFileSync(`${base}.results.jsonl`, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
writeFileSync(`${base}.summary.json`, JSON.stringify(buildSummaryJson(env, results, mandatoryIds), null, 2), 'utf8')
writeFileSync(`${base}.junit.xml`, buildJunitXml(results, suiteName), 'utf8')

const failed = results.filter((r) => r.resultCode !== 'PASS' && r.resultCode !== 'SKIP_PRECONDITION')
console.log(`${results.length}개 케이스 처리 완료 (${base}.*), 실패 ${failed.length}건`)
for (const r of results) {
  console.log(`${r.resultCode === 'PASS' ? 'PASS' : 'FAIL'}  ${r.testCaseId}  (${r.resultCode})`)
}
process.exit(failed.length > 0 ? 1 : 0)
