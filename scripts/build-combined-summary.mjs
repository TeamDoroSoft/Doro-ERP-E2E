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

// Markdown 표 셀 안에서 `|`가 열을 깨고 줄바꿈이 표를 무너뜨리므로 이스케이프/한 줄로 축약한다.
function mdCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

// observed는 케이스마다 필드가 제각각이라(shared/result-schema.md 참고) 정해진 스키마 없이
// 앞쪽 몇 개 필드만 `key=value`로 이어붙인 짧은 요약을 만든다 — errorClass가 없을 때의 fallback.
function summarizeObserved(observed) {
  if (!observed || typeof observed !== 'object') return ''
  const entries = Object.entries(observed)
  if (entries.length === 0) return ''
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === 'object' && value !== null ? JSON.stringify(value) : value}`)
    .join(', ')
}

const NOTE_MAX_LENGTH = 120

// PASS는 비고 없음. 그 외(FAIL_*/ERROR_*/ABORT_SAFETY/SKIP_PRECONDITION)는 errorClass를 우선
// 쓰고(SKIP_PRECONDITION도 errorClass에 스킵 사유가 들어있다 — session-flow.js 등에서 확인),
// errorClass가 없으면 observed 요약으로 대신한다.
function noteFor(caseRecord) {
  if (caseRecord.resultCode === 'PASS') return ''
  const raw = caseRecord.errorClass || summarizeObserved(caseRecord.observed)
  if (!raw) return ''
  return raw.length > NOTE_MAX_LENGTH ? `${raw.slice(0, NOTE_MAX_LENGTH - 1)}…` : raw
}

// combined-summary.json/각 스위트 results.jsonl을 사람이 읽기 좋게 재구성한 요약을 만든다 —
// 정본은 그쪽이고 이 파일은 파생 산출물이다. testCaseId 오름차순(사전순) 정렬 — 현재 이 저장소의
// 모든 테스트 ID(AUTH-001~035, SESS-001~007, QUEUE-001~003, CATALOG-001~006, AUDIT-001, SALES-001,
// FE-BE-001~015, OPS-001~005)가 전부 3자리 zero-padded 숫자 접미사라 사전순 정렬이 곧 숫자순
// 정렬과 같다(자릿수가 갈리는 ID가 아직 없어 별도 숫자 비교 로직은 필요 없다고 판단했다 —
// 나중에 두 자리/네 자리 ID가 추가되면 이 정렬을 숫자 비교로 바꿔야 한다).
function buildReportMarkdown(runId, allCases, summary) {
  const sortedCases = [...allCases].sort((a, b) => (a.testCaseId < b.testCaseId ? -1 : a.testCaseId > b.testCaseId ? 1 : 0))

  const passCount = sortedCases.filter((c) => c.resultCode === 'PASS').length
  const skipCount = sortedCases.filter((c) => c.resultCode === 'SKIP_PRECONDITION').length
  const failCount = sortedCases.length - passCount - skipCount

  const rows = sortedCases.map(
    (c) => `| ${mdCell(c.testCaseId)} | ${mdCell(c.resultCode)} | ${mdCell(noteFor(c))} |`,
  )

  return `# 실행 결과 (${runId})

> 이 파일은 \`combined-summary.json\`과 각 스위트의 \`<suite>.results.jsonl\`을 사람이 읽기 좋게
> testCaseId 순으로 재구성한 것이다 — **정본은 그쪽이며, 이 파일은 자동 생성되는 파생 산출물이다.**

전체 ${sortedCases.length}건 — PASS ${passCount} / FAIL 계열 ${failCount} / SKIP ${skipCount},
passConnected = ${summary.passConnected}

| ID | 결과 | 비고 |
|---|---|---|
${rows.join('\n')}
`
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

// FE-BE-005/006은 배포 Frontend–Backend 종단 검증.md §3이 정의한 정상 동작 자체가 Browser
// 계측에 에러로 잡힌다 — FE-BE-005(잘못된 비밀번호)는 401 응답이 콘솔 네트워크 에러로 남고,
// FE-BE-006(로그아웃)은 로그아웃 후 보호 API가 실제로 거절되는지 확인하는 과정 자체가
// failedRequiredRequestCount를 1 올린다. 둘 다 각 케이스 자체의 assertions는 전부 PASS다.
// 여기 적은 값을 "초과"하는 에러는 여전히 실제 결함으로 걸러야 하므로 케이스 전체를 건너뛰지
// 않고 필드별 허용치만 둔다.
const EXPECTED_BROWSER_ERROR_COUNTS = {
  'FE-BE-005': { consoleErrorCount: 1, pageErrorCount: 0, failedRequiredRequestCount: 0 },
  'FE-BE-006': { consoleErrorCount: 0, pageErrorCount: 0, failedRequiredRequestCount: 1 },
}
const NO_EXPECTED_BROWSER_ERRORS = { consoleErrorCount: 0, pageErrorCount: 0, failedRequiredRequestCount: 0 }

const browserLayerCases = browserCases.filter((result) => result.layer === 'FRONTEND_E2E')
const browserErrorsAbsent =
  browserLayerCases.length > 0
    ? browserLayerCases.every((result) => {
        const allowed = EXPECTED_BROWSER_ERROR_COUNTS[result.testCaseId] ?? NO_EXPECTED_BROWSER_ERRORS
        return (
          (result.browser?.consoleErrorCount ?? 0) <= allowed.consoleErrorCount &&
          (result.browser?.pageErrorCount ?? 0) <= allowed.pageErrorCount &&
          (result.browser?.failedRequiredRequestCount ?? 0) <= allowed.failedRequiredRequestCount
        )
      })
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
  'browserErrorsAbsent는 FE-BE-005(consoleErrorCount<=1)/FE-BE-006(failedRequiredRequestCount<=1)만 ' +
    '허용 목록으로 두고, 그 외 케이스나 그 이상의 초과분은 여전히 false로 엄격 판정한다.',
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

const reportPath = resolve(runDir, 'report.md')
writeFileSync(reportPath, buildReportMarkdown(runId, cases, combined), 'utf8')

console.log(`작성 완료: reports/${runId}/combined-summary.json`)
console.log(`작성 완료: reports/${runId}/report.md`)
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
