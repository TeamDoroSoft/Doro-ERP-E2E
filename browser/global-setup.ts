import type { FullConfig } from '@playwright/test'
import { loadDeployEnv } from './lib/env'
import { makeRunId } from './lib/runContext'

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // env 검증 실패(ConfigError)는 여기서 그대로 throw해 테스트가 하나도 시작되기 전에
  // 전체 실행을 중단한다 — 배포 Frontend–Backend 종단 검증.md §2 "Frontend Origin 미승인 시 브라우저 E2E 전체 중단".
  const env = loadDeployEnv()
  const runId = process.env.DORO_RUN_ID ?? makeRunId()
  // Playwright worker 프로세스는 globalSetup 종료 후 이 프로세스의 env를 물려받아 spawn되므로,
  // 여기서 정한 runId를 모든 테스트 파일이 process.env.DORO_RUN_ID로 그대로 읽을 수 있다.
  process.env.DORO_RUN_ID = runId
  // eslint-disable-next-line no-console
  console.log(`[doro-erp-e2e] runId=${runId} targetHost=${new URL(env.frontendOrigin).host} environment=${env.environment}`)
}
