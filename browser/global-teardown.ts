import { loadDeployEnv } from './lib/env'
import { writeSummary } from './lib/summary'

export default async function globalTeardown(): Promise<void> {
  const runId = process.env.DORO_RUN_ID
  if (!runId) return // global-setup이 실패해 테스트가 아예 시작되지 못한 경우
  const env = loadDeployEnv()
  writeSummary(runId, env)
  // eslint-disable-next-line no-console
  console.log(`[doro-erp-e2e] summary.json 기록 완료: reports/${runId}/summary.json`)
}
