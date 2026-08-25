import type { DeployEnv } from './env'

// FE-BE-010(임시 비밀번호 화면)·FE-BE-014(Role별 화면)가 쓰는 1회용 Fixture 생성기.
// api/lib/provisioning.js의 k6 버전과 같은 Provisioning API를 Node fetch로 호출하는 버전이다.
// AUTH_VALID_01을 재사용하지 않고 이 케이스 전용 테넌트+직원을 만들고 버린다.
//
// Provisioning 자격증명(STORE_ACCESS_PROVISIONING_USERNAME/PASSWORD)과 PROVISIONING_ORIGIN이
// 없으면 관련 테스트만 SKIP_PRECONDITION으로 건너뛴다 — SESS-004/005·AUTH-013/014와 같은 설계다.
export function provisioningAvailable(env: DeployEnv): boolean {
  return !!(env.provisioning.origin && env.provisioning.username && env.provisioning.password)
}

function authHeader(env: DeployEnv): string {
  return `Basic ${Buffer.from(`${env.provisioning.username}:${env.provisioning.password}`).toString('base64')}`
}

// 로컬 리허설(자체 서명 TLS) 대상일 때만 Node의 TLS 검증을 끈다 — env.ts의 requireOrigin이 허용하는
// http://localhost 예외와 짝을 이루며, 실제 dev/stage/prod Origin에는 적용되지 않는다.
export function allowLocalSelfSignedCert(env: DeployEnv): void {
  if (env.environment.startsWith('local')) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }
}

export function randomToken(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

// PasswordPolicyValidator.MIN_LENGTH = 15, 그리고 비밀번호가 loginId를 부분 문자열로 포함하면
// 거부한다(AUTH-013/014에서 실측 확인) — 호출부는 접두어에 loginId가 안 겹치게 주의해야 한다.
export function randomPassword(prefix: string): string {
  return `${prefix}-${randomToken()}`
}

export interface ThrowawayFixture {
  tenantCode: string
  tenantName: string
  storeName: string
  loginId: string
  temporaryPassword: string
}

export async function provisionThrowawayOwner(env: DeployEnv, fixture: ThrowawayFixture): Promise<{ tenantId: string }> {
  if (!env.provisioning.origin) throw new Error('PROVISIONING_ORIGIN이 없습니다')
  allowLocalSelfSignedCert(env)
  const headers = { 'Content-Type': 'application/json', Authorization: authHeader(env) }

  const tenantRes = await fetch(`${env.provisioning.origin}/internal/v1/tenants`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantCode: fixture.tenantCode, tenantName: fixture.tenantName, storeName: fixture.storeName }),
  })
  if (tenantRes.status !== 200) {
    throw new Error(`1회용 테넌트 Provisioning 실패: HTTP ${tenantRes.status} — ${await tenantRes.text()}`)
  }
  const tenantBody = (await tenantRes.json()) as { tenantId: string }

  const ownerRes = await fetch(`${env.provisioning.origin}/internal/v1/tenants/${tenantBody.tenantId}/first-owner`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ loginId: fixture.loginId, temporaryPassword: fixture.temporaryPassword }),
  })
  if (ownerRes.status !== 200) {
    throw new Error(`1회용 OWNER Provisioning 실패: HTTP ${ownerRes.status} — ${await ownerRes.text()}`)
  }

  return { tenantId: tenantBody.tenantId }
}

// --- 아래는 직접 API 호출로 계정 상태를 준비하는 헬퍼들(브라우저 열기 전 Setup 단계 전용) ---
// FE-BE-010/014의 실제 검증(화면 확인)은 Playwright page로 하지만, Fixture 준비(로그인·비밀번호
// 변경·직원 생성)는 매번 브라우저를 띄우면 느리고 불필요해서 Node fetch로 직접 한다.

export type CookieJar = Record<string, string>

function parseCookies(res: Response): CookieJar {
  const jar: CookieJar = {}
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const raw = getSetCookie ? getSetCookie.call(res.headers) : []
  for (const line of raw) {
    const [pair] = line.split(';')
    const idx = pair.indexOf('=')
    jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return jar
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

export interface LoginOutcome {
  status: number
  passwordChangeRequired?: boolean
  cookies: CookieJar
}

export async function loginViaApi(env: DeployEnv, tenantCode: string, loginId: string, password: string): Promise<LoginOutcome> {
  allowLocalSelfSignedCert(env)
  const res = await fetch(`${env.apiOrigin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantCode, loginId, password }),
  })
  const body = (await res.json().catch(() => ({}))) as { passwordChangeRequired?: boolean }
  return { status: res.status, passwordChangeRequired: body.passwordChangeRequired, cookies: parseCookies(res) }
}

export async function completePasswordChangeViaApi(
  env: DeployEnv,
  jar: CookieJar,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  allowLocalSelfSignedCert(env)
  const res = await fetch(`${env.apiOrigin}/api/v1/employees/me/password`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      'X-XSRF-TOKEN': jar['XSRF-TOKEN'] ?? '',
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (res.status !== 200) {
    throw new Error(`비밀번호 변경 실패: HTTP ${res.status} — ${await res.text()}`)
  }
}

export async function createEmployeeViaApi(
  env: DeployEnv,
  jar: CookieJar,
  input: { loginId: string; temporaryPassword: string; role: 'OWNER' | 'MANAGER' | 'STAFF' },
): Promise<{ id: string }> {
  allowLocalSelfSignedCert(env)
  const res = await fetch(`${env.apiOrigin}/api/v1/employees`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      'X-XSRF-TOKEN': jar['XSRF-TOKEN'] ?? '',
      'Idempotency-Key': randomToken(),
    },
    body: JSON.stringify(input),
  })
  if (res.status !== 200) {
    throw new Error(`직원 생성 실패: HTTP ${res.status} — ${await res.text()}`)
  }
  return (await res.json()) as { id: string }
}
