#!/usr/bin/env node
// 필수 도메인 상태변경 커버리지의 사용자용 사전 준비 래퍼다.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const requiredOptions = ['--destructive-auth', '--destructive-queue', '--destructive-catalog', '--destructive-order']

export function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('사용법: node scripts/gates/prepare-and-run-required-gate.mjs [--aws-profile <name>] [--environment <name>] [--env-file <path>] [--preflight-only]')
    console.log('필수 도메인 상태변경 커버리지를 위한 사전 점검 후 배포 검증을 실행합니다. 인프라 장애 주입은 포함하지 않습니다.')
    return 0
  }
  const result = spawnSync(
    process.execPath,
    ['scripts/gates/prepare-and-run-full-gate.mjs', ...requiredOptions, ...args],
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
  )
  if (result.error) throw result.error
  return result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main())
  } catch (error) {
    console.error('ERROR: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(2)
  }
}
