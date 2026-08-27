#!/usr/bin/env node
// browser(Playwright)와 api(k6) 결과를 같은 runId 기준으로 묶어 하나의 판정을 만든다. 두 러너에
// 같은 DORO_RUN_ID를 지정해서 실행해야 서로 짝지어진다 — README "실행" 절 참고.
//
// 사용법: node scripts/build-combined-summary.mjs <runId>
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const reportsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'reports')

const [, , runId] = process.argv
if (!runId) {
  console.error('사용법: node scripts/build-combined-summary.mjs <runId>')
  console.error('browser와 api 양쪽 실행에 같은 DORO_RUN_ID를 지정해야 서로 짝지어진다.')
  process.exit(2)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJsonl(path) {
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

// browser: reports/<runId>/summary.json (browser/lib/summary.ts가 씀)
const browserSummaryPath = resolve(reportsDir, runId, 'summary.json')
const browser = existsSync(browserSummaryPath)
  ? { summaryPath: `reports/${runId}/summary.json`, ...readJson(browserSummaryPath) }
  : null
const browserCases = readJsonl(resolve(dirname(browserSummaryPath), 'results.jsonl'))

// api: reports/<runId>/<suite>.summary.json (api/lib/build-report.mjs가 씀, suite마다 하나씩).
// browser도 같은 reports/<runId>/ 폴더에 summary.json(접두어 없음)을 쓰므로, 그 자기 자신을
// api suite로 중복 집계하지 않도록 정확히 그 파일명은 제외한다.
const runDir = resolve(reportsDir, runId)
const apiSuiteFiles = existsSync(runDir)
  ? readdirSync(runDir).filter((name) => name.endsWith('.summary.json') && name !== 'summary.json')
  : []
const apiSuites = apiSuiteFiles.map((name) => {
  const suite = name.slice(0, -'.summary.json'.length)
  return { suite, summaryPath: `reports/${runId}/${name}`, ...readJson(resolve(runDir, name)) }
})
const apiCases = apiSuiteFiles.flatMap((name) =>
  readJsonl(resolve(runDir, name.replace(/\.summary\.json$/, '.results.jsonl'))),
)
const cases = [...browserCases, ...apiCases]

if (!browser && apiSuites.length === 0) {
  console.error(`runId="${runId}"에 해당하는 browser/api 결과를 reports/${runId}/ 아래에서 찾지 못했습니다.`)
  console.error('browser는 reports/<runId>/summary.json, api는 reports/<runId>/<suite>.summary.json을 찾는다.')
  process.exit(1)
}

const mandatoryBrowserPassed = browser ? browser.mandatoryBrowserPassed === true : null
const mandatoryApiPassed = apiSuites.length > 0 ? apiSuites.every((s) => s.mandatoryApiPassed === true) : null

const sensitiveDataLeakCount =
  (browser?.sensitiveDataLeakCount ?? 0) + apiSuites.reduce((sum, s) => sum + (s.sensitiveDataLeakCount ?? 0), 0)

const protectedApiCase = browserCases.find((result) => result.testCaseId === 'FE-BE-003')
const protectedApiReachedFromBrowser = protectedApiCase ? protectedApiCase.resultCode === 'PASS' : null

const browserLayerCases = browserCases.filter((result) => result.layer === 'FRONTEND_E2E')
const browserErrorsAbsent =
  browserLayerCases.length > 0
    ? browserLayerCases.every(
        (result) =>
          result.browser?.consoleErrorCount === 0 &&
          result.browser?.pageErrorCount === 0 &&
          result.browser?.failedRequiredRequestCount === 0,
      )
    : null

const REQUEST_CORRELATION_CASE_IDS = new Set(['FE-BE-002', 'FE-BE-003', 'FE-BE-004', 'FE-BE-005', 'FE-BE-006'])
const requestCorrelationCases = browserCases.filter((result) => REQUEST_CORRELATION_CASE_IDS.has(result.testCaseId))
const requestCorrelationVerified =
  requestCorrelationCases.length > 0
    ? requestCorrelationCases.every(
        (result) => typeof result.requestId === 'string' && result.requestId.trim() !== '',
      )
    : null

const deployments = [browser?.deployment, ...apiSuites.map((s) => s.deployment)].filter(Boolean)
const deploymentIdentityComplete =
  deployments.length > 0 &&
  deployments.every(
    (d) =>
      d.frontendRevision !== 'unknown' &&
      d.cloudFrontDistributionId !== 'unknown' &&
      d.edgeRevision !== 'unknown' &&
      d.storeAccessRevision !== 'unknown',
  )

// 배포 Frontend–Backend 종단 검증.md §7의 PASS_CONNECTED 전체 판정식은 deploymentIdentityComplete·
// protectedApiReachedFromBrowser·requestCorrelationVerified·browserErrorsAbsent(Console/Page
// Error 허용 목록 포함)까지 요구한다. 이 스크립트는 그중 "필수 케이스 전부 PASS + 민감정보
// 유출 0건"만 보는 좁은 판정이다 — Revision 조회와 Console/Page Error 허용 목록이 아직 없어서
// 나머지 조건까지 넣으면 항상 false가 나와 의미가 없어진다. deploymentIdentityComplete는
// 정보 제공용으로만 계산하고 게이트에서는 뺐다.
const frontBackConnected =
  (mandatoryBrowserPassed === null || mandatoryBrowserPassed === true) &&
  (mandatoryApiPassed === null || mandatoryApiPassed === true) &&
  (mandatoryBrowserPassed !== null || mandatoryApiPassed !== null) &&
  sensitiveDataLeakCount === 0

const passConnected =
  deploymentIdentityComplete === true &&
  mandatoryBrowserPassed === true &&
  mandatoryApiPassed === true &&
  protectedApiReachedFromBrowser === true &&
  requestCorrelationVerified === true &&
  browserErrorsAbsent === true &&
  sensitiveDataLeakCount === 0

const caveats = []
if (browser === null) caveats.push('browser(Playwright) 결과를 찾지 못해 mandatoryBrowserPassed를 null로 뒀다.')
if (apiSuites.length === 0) caveats.push('api(k6) 결과를 찾지 못해 mandatoryApiPassed를 null로 뒀다.')
if (!deploymentIdentityComplete)
  caveats.push(
    'deploymentIdentityComplete=false — Frontend/CloudFront/Edge/StoreAccess Revision 조회를 아직 구현하지 않아 ' +
      '정보 제공용일 뿐 frontBackConnected 게이트에는 반영하지 않았다.',
  )
caveats.push(
  '배포 Frontend–Backend 종단 검증.md §7의 protectedApiReachedFromBrowser·browserErrorsAbsent는 ' +
    'frontBackConnected 게이트에는 반영하지 않았다 — frontBackConnected는 ' +
    '"필수 케이스 전부 PASS + 민감정보 유출 0건"만 보는 좁은 판정이며 같은 문서 §9의 완료 조건 전체를 대체하지 않는다.',
)
caveats.push(
  'browserErrorsAbsent는 승인된 에러 허용 목록 개념이 아직 없어 console/page/required-request 에러가 하나라도 있으면 false로 엄격 판정한다.',
)
caveats.push(
  'requestCorrelationVerified는 FE-BE-002~006 Browser 결과의 requestId 존재 여부만 확인하는 좁은 대리 지표이며, Browser 응답과 Edge·Store Access Log를 실제로 대조하지 않는다.',
)
caveats.push(
  'passConnected는 배포 Frontend–Backend 종단 검증.md §9 완료 조건의 엄격한 판정으로, 구성 항목 중 하나라도 null 또는 false이면 false다.',
)

const combined = {
  schemaVersion: 1,
  runId,
  generatedAt: new Date().toISOString(),
  browser,
  api: { suites: apiSuites, mandatoryApiPassed },
  cases,
  sensitiveDataLeakCount,
  deploymentIdentityComplete,
  protectedApiReachedFromBrowser,
  requestCorrelationVerified,
  browserErrorsAbsent,
  frontBackConnected,
  passConnected,
  caveats,
}

const outPath = resolve(runDir, 'combined-summary.json')
writeFileSync(outPath, JSON.stringify(combined, null, 2), 'utf8')

console.log(`작성 완료: reports/${runId}/combined-summary.json`)
console.log(`  mandatoryBrowserPassed = ${mandatoryBrowserPassed}`)
console.log(`  mandatoryApiPassed     = ${mandatoryApiPassed} (${apiSuites.map((s) => s.suite).join(', ') || '없음'})`)
console.log(`  sensitiveDataLeakCount = ${sensitiveDataLeakCount}`)
console.log(`  requestCorrelationVerified = ${requestCorrelationVerified}`)
console.log(`  passConnected = ${passConnected}`)
console.log(`  frontBackConnected (좁은 판정) = ${frontBackConnected}`)
if (passConnected !== frontBackConnected) {
  console.log(
    `⚠ passConnected(${passConnected})와 frontBackConnected(${frontBackConnected})가 다릅니다 — 어느 §7 세부 조건이 걸렸는지 아래 값을 확인하세요.`,
  )
  console.log(`  deploymentIdentityComplete     = ${deploymentIdentityComplete}`)
  console.log(`  mandatoryBrowserPassed         = ${mandatoryBrowserPassed}`)
  console.log(`  mandatoryApiPassed             = ${mandatoryApiPassed}`)
  console.log(`  protectedApiReachedFromBrowser = ${protectedApiReachedFromBrowser}`)
  console.log(`  requestCorrelationVerified     = ${requestCorrelationVerified}`)
  console.log(`  browserErrorsAbsent            = ${browserErrorsAbsent}`)
  console.log(`  sensitiveDataLeakCount         = ${sensitiveDataLeakCount}`)
}
process.exit(passConnected ? 0 : 1)
