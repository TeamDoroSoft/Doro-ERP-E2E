#!/usr/bin/env node
// 일반 사용자를 위한 단일 E2E 진입점이다. EKS 변경은 이 메뉴의 y 확인을 거쳐야만 실행된다.
import { execFileSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readline = createInterface({ input, output })
let inputClosed = false
readline.on('close', () => {
  inputClosed = true
})

async function ask(prompt) {
  if (inputClosed) return '0'
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer) => {
      if (settled) return
      settled = true
      readline.removeListener('close', onClose)
      resolve(answer)
    }
    const onClose = () => finish('0')
    readline.once('close', onClose)
    readline.question(prompt).then(finish, () => finish('0'))
  })
}

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, env: process.env, stdio: 'inherit' })
  if (result.error) console.error('실행 오류: ' + result.error.message)
  console.log(`\n실행 종료 코드: ${result.status ?? 1}`)
}

function listAwsProfiles() {
  try {
    return execFileSync('aws', ['configure', 'list-profiles'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((profile) => profile.trim())
      .filter(Boolean)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('AWS CLI 프로필을 읽을 수 없습니다. AWS CLI 설치 및 사용자 CLI 설정을 확인하세요.\n' + detail)
    return []
  }
}

async function selectAwsProfile() {
  const profiles = listAwsProfiles()
  if (profiles.length === 0) {
    console.log('선택 가능한 AWS CLI 프로필이 없습니다. 메뉴를 종료합니다.')
    return false
  }

  while (true) {
    console.log('\n[AWS CLI 프로필 선택]')
    profiles.forEach((profile, index) => {
      const recommended = profile === 'erp-prod' ? ' (배포 검증 권장)' : ''
      console.log(`${index + 1}. ${profile}${recommended}`)
    })
    console.log('0. 종료')
    const choice = (await ask('번호 입력: ')).trim()
    if (choice === '0') return false
    const index = Number.parseInt(choice, 10) - 1
    if (!Number.isInteger(index) || index < 0 || index >= profiles.length) {
      console.log('표시된 번호 또는 0을 입력하세요.')
      continue
    }
    process.env.AWS_PROFILE = profiles[index]
    console.log(`선택된 AWS_PROFILE: ${process.env.AWS_PROFILE}`)
    return true
  }
}

async function selectInfrastructureScope() {
  while (true) {
    console.log('\n[인프라 조작 장애 주입]')
    console.log('1. 로컬 Docker 장애 주입')
    console.log('2. 배포 EKS 장애 주입')
    console.log('0. 이전 메뉴')
    const choice = (await ask('번호 입력: ')).trim()
    if (choice === '0') return
    if (choice === '1') {
      run('scripts/gates/run-infrastructure-fault-injection.mjs', ['--scope=local'])
      continue
    }
    if (choice !== '2') {
      console.log('1, 2, 0 중 하나를 입력하세요.')
      continue
    }

    console.log('\n경고: 배포 EKS 장애 주입은 HPA, Deployment, Service selector 또는 Pod를 실제로 변경합니다.')
    console.log('      CloudFront 조회 권한은 필요하지 않지만, 대상 EKS의 kubectl Context와 RBAC 권한이 필요합니다.')
    const confirmation = (await ask('진행하시겠습니까? (y/n): ')).trim().toLowerCase()
    if (confirmation === 'y') {
      run('scripts/gates/run-infrastructure-fault-injection.mjs', ['--scope=eks', '--confirmed'])
    } else if (confirmation !== 'n') {
      console.log('y 또는 n을 입력하세요. 인프라 대상 선택 메뉴로 돌아갑니다.')
    }
  }
}

async function main() {
  if (!(await selectAwsProfile())) return
  while (true) {
    console.log('\n[Doro ERP E2E 실행 메뉴]')
    console.log('1. 배포 필수 검증')
    console.log('2. 인프라 조작 장애 주입')
    console.log('0. 종료')
    const choice = (await ask('번호 입력: ')).trim()
    if (choice === '0') return
    if (choice === '1') {
      console.log('\n안내: 배포 필수 검증은 프로젝트 AWS 계정 로그인과 CloudFront 조회 권한이 필요합니다.')
      console.log('      AWS CLI 자격증명, k6, Playwright Chromium, 배포 E2E 환경 파일을 확인한 뒤 실행합니다.')
      run('scripts/gates/prepare-and-run-required-gate.mjs')
      continue
    }
    if (choice === '2') {
      console.log('\n안내: 로컬 Docker 장애 주입은 AWS 로그인이 필요하지 않습니다.')
      console.log('      배포 EKS 장애 주입은 CloudFront 조회는 하지 않지만 EKS kubectl Context와 RBAC 권한이 필요합니다.')
      await selectInfrastructureScope()
      continue
    }
    console.log('1, 2, 0 중 하나를 입력하세요.')
  }
}

try {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('사용법: node scripts/gates/run-e2e-menu.mjs')
    console.log('배포 필수 검증 또는 인프라 조작 장애 주입을 대화형 메뉴에서 선택합니다.')
  } else {
    await main()
  }
} finally {
  readline.close()
}
