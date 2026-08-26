import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const frontendOrigin = process.env.DORO_FRONTEND_ORIGIN ?? ''

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  // JSONL append는 순차적이어야 하고, 케이스마다 실제 로그인을 새로 수행하므로(독립
  // Browser Context) 병렬로 돌릴 이유가 없다. 계정 Rate Limit Bucket(api/README.md
  // 참고)도 동시에 여러 로그인이 겹치지 않아야 안전하다.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // 로그인은 Command라 자동 재시도하지 않는다. CI Retry를 쓰려면 별도 Browser
  // Context와 새 testCaseAttempt 기록이 필요한데 아직 구현하지 않았다 — 지금은 항상 0이다.
  retries: 0,
  reporter: [
    ['list'],
    ['junit', { outputFile: '../reports/latest-browser-junit.xml' }],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: frontendOrigin,
    actionTimeout: 10_000,
    // 배포 Frontend–Backend 종단 검증.md §2, §8: 로그인 단계의 Trace·Video·DOM Snapshot은
    // 기본 저장하지 않는다.
    trace: 'off',
    video: 'off',
    // 실패 Screenshot은 입력값을 지운 뒤 촬영해야 하므로 자동 촬영을 쓰지 않고
    // 필요한 테스트 안에서 직접 캡처한다.
    screenshot: 'off',
    headless: true,
  },
  projects: [{ name: 'chromium-deploy', use: { ...devices['Desktop Chrome'] } }],
})
