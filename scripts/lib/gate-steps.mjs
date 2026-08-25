// run-mandatory-gate.mjs / run-full-gate.mjs가 공유하는 "한 단계 실행" 도우미들.
//
// 파괴적 플래그(RUN_DESTRUCTIVE_AUTH_TESTS, RUN_FAULT_INJECTION_TESTS)는 이 파일이 절대
// 대신 켜주지 않는다 — 호출하는 사람이 실행 전에 직접 export해야만 해당 케이스들이 실제로
// 돈다. 대신 안 켜져 있으면 어떤 케이스가 SKIP되는지, 켜려면 뭘 해야 하는지 guidance만
// 안내한다(README/api/README.md에 이미 있는 설명을 실행 시점에 다시 보여주는 것뿐).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BROWSER_DIR = resolve(REPO_ROOT, 'browser')
export const REPORTS_DIR = resolve(REPO_ROOT, 'reports')

export function ensureRunId() {
  if (!process.env.DORO_RUN_ID) {
    process.env.DORO_RUN_ID = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
  }
  return process.env.DORO_RUN_ID
}

function heading(title) {
  console.log('')
  console.log(`=== ${title} ===`)
}

// 실패해도 나머지 단계는 계속 진행한다 — 하나의 케이스 그룹이 FAIL/ERROR라고 해서 뒤에 있는
// 다른 그룹까지 못 도는 건 "부분 결과라도 최대한 모아서 보여준다"는 이 오케스트레이터의
// 목적에 안 맞는다. 최종 통과 여부는 마지막에 모든 Step 결과를 모아서 판단한다.
export async function runStep(name, fn) {
  heading(name)
  try {
    const result = await fn()
    const ok = result?.ok !== false
    const label = result?.skipped ? 'SKIP' : ok ? 'OK' : 'FAIL'
    console.log(`[${name}] ${label}`)
    return { name, ok, ...result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[${name}] ERROR: ${message}`)
    return { name, ok: false, error: message }
  }
}

export function guardFlag(envVarName, forWhat, howToEnable) {
  if (process.env[envVarName] === 'true') return true
  console.log(`  ⚠ ${envVarName}가 설정돼 있지 않습니다 — ${forWhat}는 이번 실행에서 SKIP됩니다.`)
  console.log(`    실행하려면: ${howToEnable}`)
  return false
}

export function runPlaywrightSpec(specFile) {
  try {
    execFileSync('npx', ['playwright', 'test', specFile], {
      cwd: BROWSER_DIR,
      stdio: 'inherit',
      env: process.env,
    })
    return { ok: true, status: 0 }
  } catch (error) {
    return { ok: false, status: error.status ?? 1 }
  }
}

// k6는 handleSummary()가 VU 실행과 격리된 별도 VM에서 돌아 결과를 못 봐서(resultLogger.js
// 주석 참고), --log-format=raw로 stdout에 찍은 케이스별 JSON 줄을 파일로 모았다가
// build-report.mjs로 후처리해야 한다 — README의 "실행" 절과 같은 2단계.
export function runK6Scenario(scenarioRelPath, suiteName, caseIds) {
  mkdirSync(REPORTS_DIR, { recursive: true })
  const runId = process.env.DORO_RUN_ID
  const rawLogPath = resolve(REPORTS_DIR, `${runId}.${suiteName}.raw.log`)

  let k6Status = 0
  try {
    const output = execFileSync('k6', ['run', '--log-format=raw', scenarioRelPath], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: 'utf8',
      // 실패(threshold 미달)해도 로그는 그대로 받아서 후처리해야 하므로, 여기서 던지지 않고
      // 아래 catch에서 stdout을 그대로 흡수한다.
      maxBuffer: 64 * 1024 * 1024,
    })
    writeFileSync(rawLogPath, output, 'utf8')
  } catch (error) {
    k6Status = error.status ?? 1
    writeFileSync(rawLogPath, `${error.stdout ?? ''}`, 'utf8')
  }

  try {
    execFileSync(
      'node',
      ['api/lib/build-report.mjs', rawLogPath, suiteName, caseIds.join(',')],
      { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
    )
    return { ok: true, status: 0, k6Status }
  } catch (error) {
    return { ok: false, status: error.status ?? 1, k6Status }
  }
}

export function runNodeScript(scriptRelPath, args = []) {
  try {
    execFileSync('node', [scriptRelPath, ...args], { cwd: REPO_ROOT, stdio: 'inherit', env: process.env })
    return { ok: true, status: 0 }
  } catch (error) {
    return { ok: false, status: error.status ?? 1 }
  }
}

export function printFinalSummary(steps) {
  heading('종합 결과')
  for (const step of steps) {
    const label = step.skipped ? 'SKIP' : step.ok ? 'OK  ' : 'FAIL'
    console.log(`${label}  ${step.name}`)
  }
  const failed = steps.filter((s) => !s.ok)
  console.log('')
  console.log(failed.length === 0 ? '모든 단계 통과' : `${failed.length}개 단계 실패: ${failed.map((s) => s.name).join(', ')}`)
  return failed.length === 0
}
