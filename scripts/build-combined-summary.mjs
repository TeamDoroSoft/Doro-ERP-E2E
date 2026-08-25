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

// browser: reports/<runId>/summary.json (browser/lib/summary.ts가 씀)
const browserSummaryPath = resolve(reportsDir, runId, 'summary.json')
const browser = existsSync(browserSummaryPath)
  ? { summaryPath: `reports/${runId}/summary.json`, ...readJson(browserSummaryPath) }
  : null

// api: reports/<runId>.<suite>.summary.json (api/lib/build-report.mjs가 씀, suite마다 하나씩)
const apiSuiteFiles = existsSync(reportsDir)
  ? readdirSync(reportsDir).filter((name) => name.startsWith(`${runId}.`) && name.endsWith('.summary.json'))
  : []
const apiSuites = apiSuiteFiles.map((name) => {
  const suite = name.slice(runId.length + 1, -'.summary.json'.length)
  return { suite, summaryPath: `reports/${name}`, ...readJson(resolve(reportsDir, name)) }
})

if (!browser && apiSuites.length === 0) {
  console.error(`runId="${runId}"에 해당하는 browser/api 결과를 reports/ 아래에서 찾지 못했습니다.`)
  console.error('browser는 reports/<runId>/summary.json, api는 reports/<runId>.<suite>.summary.json을 찾는다.')
  process.exit(1)
}

const mandatoryBrowserPassed = browser ? browser.mandatoryBrowserPassed === true : null
const mandatoryApiPassed = apiSuites.length > 0 ? apiSuites.every((s) => s.mandatoryApiPassed === true) : null

const sensitiveDataLeakCount =
  (browser?.sensitiveDataLeakCount ?? 0) + apiSuites.reduce((sum, s) => sum + (s.sensitiveDataLeakCount ?? 0), 0)

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

// 보고서 §6.1의 FRONT_BACK_CONNECTED 전체 판정식은 deploymentIdentityComplete·
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

const caveats = []
if (browser === null) caveats.push('browser(Playwright) 결과를 찾지 못해 mandatoryBrowserPassed를 null로 뒀다.')
if (apiSuites.length === 0) caveats.push('api(k6) 결과를 찾지 못해 mandatoryApiPassed를 null로 뒀다.')
if (!deploymentIdentityComplete)
  caveats.push(
    'deploymentIdentityComplete=false — Frontend/CloudFront/Edge/StoreAccess Revision 조회를 아직 구현하지 않아 ' +
      '정보 제공용일 뿐 frontBackConnected 게이트에는 반영하지 않았다.',
  )
caveats.push(
  '보고서 §6.1의 protectedApiReachedFromBrowser·requestCorrelationVerified·browserErrorsAbsent(Console/Page ' +
    'Error 허용 목록)는 아직 이 집계에 반영하지 않았다 — frontBackConnected는 "필수 케이스 전부 PASS + ' +
    '민감정보 유출 0건"만 보는 좁은 판정이며 §11.2의 "실제 배포 검증 완료" 선언 조건 전체를 대체하지 않는다.',
)

const combined = {
  schemaVersion: 1,
  runId,
  generatedAt: new Date().toISOString(),
  browser,
  api: { suites: apiSuites, mandatoryApiPassed },
  sensitiveDataLeakCount,
  deploymentIdentityComplete,
  frontBackConnected,
  caveats,
}

const outPath = resolve(reportsDir, `${runId}.combined-summary.json`)
writeFileSync(outPath, JSON.stringify(combined, null, 2), 'utf8')

console.log(`작성 완료: reports/${runId}.combined-summary.json`)
console.log(`  mandatoryBrowserPassed = ${mandatoryBrowserPassed}`)
console.log(`  mandatoryApiPassed     = ${mandatoryApiPassed} (${apiSuites.map((s) => s.suite).join(', ') || '없음'})`)
console.log(`  sensitiveDataLeakCount = ${sensitiveDataLeakCount}`)
console.log(`  frontBackConnected (좁은 판정) = ${frontBackConnected}`)
process.exit(frontBackConnected ? 0 : 1)
