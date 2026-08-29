// run-mandatory-gate.mjs / run-full-gate.mjs가 공유하는 "한 단계 실행" 도우미들.
//
// 파괴적 플래그(RUN_DESTRUCTIVE_AUTH_TESTS, RUN_FAULT_INJECTION_TESTS)는 이 파일이 절대
// 대신 켜주지 않는다 — 호출하는 사람이 실행 전에 직접 export해야만 해당 케이스들이 실제로
// 돈다. 대신 안 켜져 있으면 어떤 케이스가 SKIP되는지, 켜려면 뭘 해야 하는지 guidance만
// 안내한다(README/api/README.md에 이미 있는 설명을 실행 시점에 다시 보여주는 것뿐).
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BROWSER_DIR = resolve(REPO_ROOT, 'browser')
export const REPORTS_DIR = resolve(REPO_ROOT, 'reports')
const PLAYWRIGHT_CLI = resolve(BROWSER_DIR, 'node_modules', '@playwright', 'test', 'cli.js')

// UTC+9(Asia/Seoul, DST 없음) 고정 오프셋으로 KST 벽시계 값을 얻는다 — 이 매장/서비스 시간대
// 전제를 쓰는 다른 코드(queue-connectivity.js의 storeNow() 등)와 같은 트릭이다. Node에는
// Intl 시간대 지원이 있지만, 이 저장소 전반의 관례를 맞추고 나중에 goja(k6) 쪽에서 같은 값이
// 필요해져도 그대로 옮겨 쓸 수 있게 동일한 방식을 쓴다.
function kstTimestamp() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  const y = kst.getUTCFullYear()
  const mo = pad(kst.getUTCMonth() + 1)
  const d = pad(kst.getUTCDate())
  const h = pad(kst.getUTCHours())
  const mi = pad(kst.getUTCMinutes())
  const s = pad(kst.getUTCSeconds())
  return `${y}-${mo}-${d}_${h}-${mi}-${s}`
}

export function ensureRunId() {
  if (!process.env.DORO_RUN_ID) {
    // KST 기준 사람이 읽기 쉬운 형식(예: run-2026-08-27_13-22-08) — Windows 폴더명에 `:`을
    // 못 쓰므로 시:분:초 구분자는 하이픈으로 통일한다.
    process.env.DORO_RUN_ID = `run-${kstTimestamp()}`
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

// 계정 Rate Limit Bucket 회복은 의도된 대기다. 긴 대기 중에도 "멈춤"으로 오해하지 않도록
// 주기적으로 남은 시간과 다음 단계를 출력한다. intervalMs는 단위 테스트에서 짧게 지정할 수 있다.
export async function waitForRateLimitRecovery({ label, waitMs, nextStep, intervalMs = 30_000 }) {
  const startedAt = Date.now()
  const waitSeconds = Math.ceil(waitMs / 1000)
  console.log('')
  console.log(`  ⏳ [인증 버킷 회복 중] ${label}`)
  console.log(`     테스트는 중단되지 않았습니다. Rate Limit 오탐을 막기 위해 약 ${waitSeconds}초 대기합니다.`)
  console.log(`     다음 단계: ${nextStep}`)

  while (true) {
    const elapsedMs = Date.now() - startedAt
    const remainingMs = Math.max(0, waitMs - elapsedMs)
    if (remainingMs === 0) break
    console.log(`     버킷 회복 중 · 남은 약 ${Math.ceil(remainingMs / 1000)}초`)
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)))
  }

  console.log(`  ✓ [인증 버킷 회복 완료] 다음 단계로 진행합니다: ${nextStep}`)
}

export function guardFlag(envVarName, forWhat, howToEnable) {
  if (process.env[envVarName] === 'true') return true
  console.log(`  ⚠ ${envVarName}가 설정돼 있지 않습니다 — ${forWhat}는 이번 실행에서 SKIP됩니다.`)
  console.log(`    실행하려면: ${howToEnable}`)
  return false
}

export function runPlaywrightSpec(specFile, args = []) {
  try {
    // npx.cmd를 shell:true로 실행하면 Windows cmd.exe가 --grep 정규식의 `|`를 파이프로
    // 해석한다. 로컬 의존성의 CLI를 현재 Node로 직접 실행하면 그룹 정규식과 인자를 변형 없이
    // 전달하고, 셸 실행도 제거할 수 있다.
    execFileSync(process.execPath, [PLAYWRIGHT_CLI, 'test', specFile, ...args], {
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
// 주석 참고), 케이스별 JSON 줄을 파일로 모았다가 build-report.mjs로 후처리해야 한다 — README의
// "실행" 절과 같은 2단계. console.log()로 찍은 그 JSON 줄은 --log-format=raw를 줘도 stdout이
// 아니라 stderr로 나온다(k6 v2.2.0 실측 확인) — execFileSync로 stdout만 캡처하면 결과가 전부
// 빈 파일이 돼 모든 케이스가 "결과 0건"으로 잡히는 버그가 있었다. --console-output으로 k6가
// 그 줄들을 직접 파일에 쓰게 해서 stdout/stderr 라우팅과 무관하게 만든다.
export function runK6Scenario(scenarioRelPath, suiteName, caseIds) {
  const runId = process.env.DORO_RUN_ID
  mkdirSync(resolve(REPORTS_DIR, runId), { recursive: true })
  const rawLogPath = resolve(REPORTS_DIR, runId, `${suiteName}.raw.log`)

  // 로컬 리허설(자체 서명 TLS) 대상일 때만 검증을 끈다 — 실 dev/stage/prod Origin은 유효한
  // 인증서를 쓰므로 이 플래그가 전혀 필요 없고, 붙이면 오히려 실 배포 검증을 약화시킨다
  // (README "로컬 Docker Prod-like 리허설 모드"의 수동 명령과 같은 조건).
  const isLocalRehearsal = (process.env.DORO_ENVIRONMENT ?? '').startsWith('local')
  const consoleOutputArg = `--console-output=${rawLogPath}`
  const k6Args = isLocalRehearsal
    ? ['run', '--insecure-skip-tls-verify', '--log-format=raw', consoleOutputArg, scenarioRelPath]
    : ['run', '--log-format=raw', consoleOutputArg, scenarioRelPath]

  let k6Status = 0
  try {
    execFileSync('k6', k6Args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    // 실패(threshold 미달)해도 --console-output 파일은 그대로 남아 있으므로 여기서는 종료
    // 코드만 기록하고, 아래 build-report.mjs 후처리는 그대로 진행한다.
    k6Status = error.status ?? 1
  }

  try {
    execFileSync(
      'node',
      ['api/lib/build-report.mjs', rawLogPath, suiteName, caseIds.join(',')],
      { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
    )
    return { ok: k6Status === 0, status: 0, k6Status }
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
