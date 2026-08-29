import type { Page } from '@playwright/test'
import type { DeployEnv } from './env'

export interface LoginOutcome {
  status: number
  requestId: string
  finalPath: string
}

/**
 * FE-BE-004/006처럼 "이미 로그인된 상태"가 전제조건인 케이스에서만 쓴다. 로그인 자체와 동시에
 * 발생하는 후속 요청(GET /api/v1/orders 등)을 같은 케이스에서 관찰해야 하는 FE-BE-002/003은
 * 이 헬퍼를 쓰지 않고 각자 테스트 안에서 Promise.all로 직접 두 응답을 함께 기다린다 — 로그인이
 * 끝난 뒤에 리스너를 등록하면 이미 지나간 요청을 놓친다.
 */
export async function loginAsAuthValid01(page: Page, env: DeployEnv): Promise<LoginOutcome> {
  await page.goto('/pos/login')
  await page.locator('input[name="tenantCode"]').fill(env.authValid01.tenantCode)
  await page.locator('input[name="loginId"]').fill(env.authValid01.loginId)
  await page.locator('input[name="password"]').fill(env.authValid01.password)

  const [loginResponse] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/v1/auth/login',
    ),
    page.locator('button.submit-button').click(),
  ])

  if (loginResponse.status() !== 200) {
    // Playwright 실패 아티팩트의 DOM 스냅샷에 입력 비밀번호가 남지 않도록, 예외를 던지기 전에
    // 민감 입력만 비운다. tenantCode/loginId는 결과 레코드에 기록하지 않는다.
    await page.locator('input[name="password"]').fill('').catch(() => {})
    throw new Error(`사전 로그인 실패 (status=${loginResponse.status()}) — 이 케이스는 로그인 성공을 전제한다`)
  }

  await page.waitForURL('**/pos/orders')
  return {
    status: loginResponse.status(),
    requestId: loginResponse.headers()['x-request-id'] ?? '',
    finalPath: new URL(page.url()).pathname,
  }
}
