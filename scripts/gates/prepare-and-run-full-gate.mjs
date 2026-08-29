#!/usr/bin/env node
// 사람이 full-gate를 실행할 때 필요한 AWS 계정·도구·환경변수·배포 Identity 검증을 한 번에
// 수행하는 안전한 진입점이다. 기존 run-full-gate.mjs는 환경이 이미 준비된 CI/디버깅용 저수준
// 진입점으로 유지한다.
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const BROWSER_DIR = resolve(REPO_ROOT, 'browser')
const GATE_LOCK_PATH = resolve(REPO_ROOT, 'reports', '.e2e-gate.lock')
const EXPECTED_AWS_ACCOUNT_ID = '727646470302'
const DESTRUCTIVE_ENV = {
  destructiveAuth: 'RUN_DESTRUCTIVE_AUTH_TESTS',
  destructiveQueue: 'RUN_DESTRUCTIVE_QUEUE_TESTS',
  destructiveCatalog: 'RUN_DESTRUCTIVE_CATALOG_TESTS',
  destructiveOrder: 'RUN_DESTRUCTIVE_ORDER_TESTS',
  faultInjection: 'RUN_FAULT_INJECTION_TESTS',
}

function readLockOwner() {
  try {
    const lock = JSON.parse(readFileSync(GATE_LOCK_PATH, 'utf8'))
    return typeof lock?.pid === 'number' ? lock : null
  } catch {
    return null
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error && typeof error === 'object' && error.code === 'ESRCH')
  }
}

function acquireGateLock() {
  mkdirSync(dirname(GATE_LOCK_PATH), { recursive: true })
  let descriptor
  try {
    descriptor = openSync(GATE_LOCK_PATH, 'wx')
  } catch (error) {
    const owner = readLockOwner()
    if (error && typeof error === 'object' && error.code === 'EEXIST' && owner && !isProcessRunning(owner.pid)) {
      // 비정상 종료로 남은 이전 실행의 락만 회수한다. 소유자를 읽지 못한 락은 생성 중일 수 있으므로
      // 건드리지 않고 새 실행을 중단해 동시 실행을 우선 차단한다.
      unlinkSync(GATE_LOCK_PATH)
      descriptor = openSync(GATE_LOCK_PATH, 'wx')
    } else if (error && typeof error === 'object' && error.code === 'EEXIST' && owner) {
      throw new Error(
        `다른 E2E 게이트가 이미 실행 중입니다 (PID=${owner.pid}, 시작=${owner.startedAt ?? 'unknown'}). ` +
          '동일 테스트 계정의 Rate Limit 오염을 막기 위해 현재 실행이 끝난 뒤 다시 시도하세요.',
      )
    } else {
      throw new Error('E2E 게이트 실행 락을 획득하지 못했습니다. 잠시 후 다시 시도하세요.')
    }
  }
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')

  return () => {
    closeSync(descriptor)
    try {
      unlinkSync(GATE_LOCK_PATH)
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error
    }
  }
}

const HELP = [
  '사용법:',
  '  node scripts/gates/prepare-and-run-full-gate.mjs [옵션]',
  '',
  '옵션:',
  '  --aws-profile <name>          지정한 AWS CLI Profile 사용(생략 시 현재 자격증명 체인)',
  '  --environment <name>         DORO_ENVIRONMENT (기본: prod-alpha)',
  '  --env-file <path>            E2E Secret env 파일 (기본: .env.deploy-e2e.local)',
  '  --destructive-auth           계정 잠금·Rate Limit 시나리오 활성화',
  '  --destructive-queue          Queue 생성·취소 시나리오 활성화',
  '  --destructive-catalog        Category·Product 생성·비활성화 시나리오 활성화',
  '  --destructive-order          주문·결제 상태 변경 시나리오 활성화',
  '  --fault-injection            실 EKS 장애 주입 활성화',
  '  --confirm-production-impact  --fault-injection과 함께 필요한 이중 확인',
  '  --preflight-only             준비 상태만 확인하고 full-gate는 실행하지 않음',
  '  --help                       도움말 출력',
].join('\n')

export function parseArgs(argv) {
  const options = {
    awsProfile: null,
    environment: 'prod-alpha',
    envFile: '.env.deploy-e2e.local',
    destructiveAuth: false,
    destructiveQueue: false,
    destructiveCatalog: false,
    destructiveOrder: false,
    faultInjection: false,
    confirmProductionImpact: false,
    preflightOnly: false,
    help: false,
  }
  const valueOptions = new Map([
    ['--aws-profile', 'awsProfile'],
    ['--environment', 'environment'],
    ['--env-file', 'envFile'],
  ])
  const flagOptions = new Map([
    ['--destructive-auth', 'destructiveAuth'],
    ['--destructive-queue', 'destructiveQueue'],
    ['--destructive-catalog', 'destructiveCatalog'],
    ['--destructive-order', 'destructiveOrder'],
    ['--fault-injection', 'faultInjection'],
    ['--confirm-production-impact', 'confirmProductionImpact'],
    ['--preflight-only', 'preflightOnly'],
    ['--help', 'help'],
    ['-h', 'help'],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (valueOptions.has(arg)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(arg + ' 뒤에 값이 필요합니다.')
      options[valueOptions.get(arg)] = value
      index += 1
      continue
    }
    if (flagOptions.has(arg)) {
      options[flagOptions.get(arg)] = true
      continue
    }
    throw new Error('알 수 없는 옵션입니다: ' + arg)
  }
  return options
}

export function parseEnvText(text) {
  const values = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) throw new Error('env 형식이 잘못됐습니다: ' + rawLine)
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

function applyDoroEnvFile(path, label) {
  const absolutePath = resolve(REPO_ROOT, path)
  if (!existsSync(absolutePath)) throw new Error(label + ' 파일이 없습니다: ' + absolutePath)
  const values = parseEnvText(readFileSync(absolutePath, 'utf8'))
  for (const [name, value] of Object.entries(values)) {
    if (!name.startsWith('DORO_')) continue
    process.env[name] = value
  }
  console.log('✓ ' + label + ' 로드 완료 (' + absolutePath + ')')
}

function runText(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function verifyTools(faultInjection) {
  runText('aws', ['--version'])
  runText('k6', ['version'])
  const playwrightCli = resolve(BROWSER_DIR, 'node_modules', 'playwright', 'cli.js')
  if (!existsSync(playwrightCli)) {
    throw new Error('Playwright가 없습니다. browser에서 npm install을 먼저 실행하세요.')
  }
  const installedBrowsers = runText(process.execPath, [playwrightCli, 'install', '--list'], { cwd: BROWSER_DIR })
  if (!/chromium/i.test(installedBrowsers)) {
    throw new Error('Playwright Chromium이 없습니다. browser에서 npx playwright install chromium을 실행하세요.')
  }
  if (faultInjection) runText('kubectl', ['version', '--client=true'])
  console.log('✓ 필수 도구 확인 완료' + (faultInjection ? ' (kubectl 포함)' : ''))
}

function verifyAwsIdentity() {
  let identity
  try {
    identity = JSON.parse(runText('aws', ['sts', 'get-caller-identity', '--output', 'json']))
  } catch (error) {
    const loginHint = process.env.AWS_PROFILE ? ' --profile ' + process.env.AWS_PROFILE : ''
    throw new Error(
      'AWS 자격증명을 확인할 수 없습니다. SSO Profile이면 aws sso login' + loginHint +
        ' 후 다시 실행하세요. 원본 오류: ' + (error instanceof Error ? error.message : String(error)),
    )
  }
  if (identity.Account !== EXPECTED_AWS_ACCOUNT_ID) {
    throw new Error(
      'AWS 계정 불일치: expected=' + EXPECTED_AWS_ACCOUNT_ID + ' actual=' + (identity.Account ?? '(unknown)') +
        '. 프로젝트 계정 자격증명 또는 해당 계정을 Assume하는 Profile을 사용하세요.',
    )
  }
  console.log('✓ AWS 프로젝트 계정 확인 완료')
  console.log('  Account=' + identity.Account)
  console.log('  Principal=' + identity.Arn)
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) throw new Error('필수 환경변수가 없습니다: ' + missing.join(', '))
}

function configureDestructiveFlags(options) {
  for (const envName of Object.values(DESTRUCTIVE_ENV)) delete process.env[envName]
  for (const [optionName, envName] of Object.entries(DESTRUCTIVE_ENV)) {
    if (options[optionName]) process.env[envName] = 'true'
  }
  if (options.faultInjection && !options.confirmProductionImpact) {
    throw new Error('--fault-injection은 --confirm-production-impact와 함께 사용해야 합니다.')
  }
  const enabled = Object.entries(DESTRUCTIVE_ENV)
    .filter(([optionName]) => options[optionName])
    .map(([, envName]) => envName)
  console.log(enabled.length === 0 ? '✓ 안전 모드: 파괴적 플래그 없음' : '⚠ 활성화된 파괴적 플래그: ' + enabled.join(', '))
}

function resolveDeploymentIdentity() {
  const result = spawnSync(process.execPath, ['scripts/gates/resolve-deployment-identity.mjs'], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Deployment Identity 조회 실패(exit=' + result.status + ')')
  applyDoroEnvFile('.env.deployment-identity.local', 'Deployment Identity')
  const identityNames = [
    'DORO_FRONTEND_REVISION',
    'DORO_CLOUDFRONT_DISTRIBUTION_ID',
    'DORO_EDGE_REVISION',
    'DORO_STORE_ACCESS_REVISION',
  ]
  requireEnv(identityNames)
  const unknown = identityNames.filter((name) => process.env[name] === 'unknown')
  if (unknown.length > 0) throw new Error('Deployment Identity가 unknown입니다: ' + unknown.join(', '))
  console.log('✓ Deployment Identity 검증 완료')
}

function verifyKubernetesAccess() {
  const context = runText('kubectl', ['config', 'current-context'])
  runText('kubectl', ['get', 'deployment', 'store-access-api', '-n', 'doro-alpha', '-o', 'name'])
  const permissions = [
    ['get', 'deployments'],
    ['list', 'pods'],
    ['create', 'pods'],
    ['delete', 'pods'],
    ['patch', 'services'],
    ['list', 'endpointslices.discovery.k8s.io'],
  ]
  const denied = permissions.filter(([verb, resource]) =>
    runText('kubectl', ['auth', 'can-i', verb, resource, '-n', 'doro-alpha']).toLowerCase() !== 'yes',
  )
  if (denied.length > 0) {
    throw new Error('EKS RBAC 권한이 부족합니다: ' + denied.map(([v, r]) => v + ' ' + r).join(', '))
  }
  console.log('✓ EKS Context/RBAC 확인 완료 (context=' + context + ', namespace=doro-alpha)')
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(HELP)
    return 0
  }
  if (options.awsProfile) process.env.AWS_PROFILE = options.awsProfile
  process.env.AWS_REGION ||= 'ap-northeast-2'
  process.env.AWS_DEFAULT_REGION ||= process.env.AWS_REGION

  console.log('=== Doro ERP full-gate 사전 준비 ===')
  console.log('AWS Profile=' + (process.env.AWS_PROFILE || '(현재/default 자격증명 체인)'))
  configureDestructiveFlags(options)
  verifyTools(options.faultInjection)
  applyDoroEnvFile(options.envFile, '배포 E2E 환경')
  process.env.DORO_ENVIRONMENT = options.environment
  requireEnv([
    'DORO_FRONTEND_ORIGIN',
    'DORO_API_ORIGIN',
    'DORO_AUTH_VALID_01_TENANT_CODE',
    'DORO_AUTH_VALID_01_LOGIN_ID',
    'DORO_AUTH_VALID_01_PASSWORD',
  ])
  if (options.destructiveAuth) {
    requireEnv([
      'DORO_AUTH_LOCKOUT_01_TENANT_CODE',
      'DORO_AUTH_LOCKOUT_01_LOGIN_ID',
      'DORO_AUTH_LOCKOUT_01_PASSWORD',
    ])
  }
  if (options.destructiveCatalog) {
    requireEnv([
      'DORO_AUTH_ROLE_OWNER_01_TENANT_CODE',
      'DORO_AUTH_ROLE_OWNER_01_LOGIN_ID',
      'DORO_AUTH_ROLE_OWNER_01_PASSWORD',
    ])
  }

  verifyAwsIdentity()
  resolveDeploymentIdentity()
  if (options.faultInjection) verifyKubernetesAccess()
  console.log('✓ full-gate 사전 준비 완료')
  if (options.preflightOnly) {
    console.log('preflight-only 요청으로 테스트는 실행하지 않습니다.')
    return 0
  }

  console.log('')
  console.log('=== full-gate 실행 ===')
  const releaseGateLock = acquireGateLock()
  try {
    const result = spawnSync(process.execPath, ['scripts/gates/run-full-gate.mjs'], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    return result.status ?? 1
  } finally {
    releaseGateLock()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main())
  } catch (error) {
    console.error('ERROR: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(2)
  }
}
