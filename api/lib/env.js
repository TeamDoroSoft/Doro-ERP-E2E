// k6는 Node가 아니라 자체 JS 런타임(goja)에서 돈다. `__ENV`는 k6가 제공하는 전역 객체로,
// `k6 run --env KEY=value` 또는 OS 환경변수로 주입된 값을 담는다.

function requireEnv(name) {
  const value = __ENV[name]
  if (!value || value.trim() === '') {
    throw new Error(`${name} 환경변수가 없습니다 (ERROR_CONFIG)`)
  }
  return value
}

function requireHttps(name, value) {
  if (!value.startsWith('https://')) {
    throw new Error(`${name}=${value} 는 HTTPS가 아닙니다 (ERROR_CONFIG, 배포 Frontend–Backend 종단 검증.md §2 즉시 중단 조건)`)
  }
  return value.replace(/\/$/, '')
}

// 실 배포 대상 테넌트 DB에 Provisioning API로 계정을 만들지 않기로 했다 — 미리 만들어둔 전용
// 계정 8개만 쓴다(Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md" 참고). 하나라도
// env에 없으면 null — 호출부는 해당 케이스를 SKIP_PRECONDITION으로 건너뛴다(Provisioning 폴백
// 없음). browser/lib/env.ts의 같은 필드와 대응된다.
function optionalAccount(prefix) {
  const tenantCode = __ENV[`DORO_${prefix}_TENANT_CODE`]
  const loginId = __ENV[`DORO_${prefix}_LOGIN_ID`]
  const password = __ENV[`DORO_${prefix}_PASSWORD`]
  if (!tenantCode || !loginId || !password) return null
  return { tenantCode, loginId, password }
}

// AUTH_PASSWORD_ROTATE_01 전용 — 비밀번호가 A/B 두 값이라 optionalAccount()로는 못 읽는다
// (SESS-005가 매번 현재 비밀번호를 스스로 판별해 반대쪽으로 바꾼다).
function optionalPasswordRotateAccount(prefix) {
  const tenantCode = __ENV[`DORO_${prefix}_TENANT_CODE`]
  const loginId = __ENV[`DORO_${prefix}_LOGIN_ID`]
  const passwordA = __ENV[`DORO_${prefix}_PASSWORD_A`]
  const passwordB = __ENV[`DORO_${prefix}_PASSWORD_B`]
  if (!tenantCode || !loginId || !passwordA || !passwordB) return null
  return { tenantCode, loginId, passwordA, passwordB }
}

function defaultRunId() {
  const now = new Date()
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-')
  return `run-api-${stamp}`
}

export function loadDeployEnv() {
  const apiOrigin = requireHttps('DORO_API_ORIGIN', requireEnv('DORO_API_ORIGIN'))

  return {
    runId: __ENV.DORO_RUN_ID || defaultRunId(),
    environment: __ENV.DORO_ENVIRONMENT || 'dev',
    apiOrigin,
    authValid01: {
      tenantCode: requireEnv('DORO_AUTH_VALID_01_TENANT_CODE'),
      loginId: requireEnv('DORO_AUTH_VALID_01_LOGIN_ID'),
      password: requireEnv('DORO_AUTH_VALID_01_PASSWORD'),
    },
    deployment: {
      frontendRevision: __ENV.DORO_FRONTEND_REVISION || 'unknown',
      cloudFrontDistributionId: __ENV.DORO_CLOUDFRONT_DISTRIBUTION_ID || 'unknown',
      edgeRevision: __ENV.DORO_EDGE_REVISION || 'unknown',
      storeAccessRevision: __ENV.DORO_STORE_ACCESS_REVISION || 'unknown',
    },
    staticAccounts: {
      lockout: optionalAccount('AUTH_LOCKOUT_01'),
      inactiveEmployee: optionalAccount('AUTH_INACTIVE_EMPLOYEE_01'),
      inactiveTenant: optionalAccount('AUTH_INACTIVE_TENANT_01'),
      roleOwner: optionalAccount('AUTH_ROLE_OWNER_01'),
      roleManager: optionalAccount('AUTH_ROLE_MANAGER_01'),
      roleStaff: optionalAccount('AUTH_ROLE_STAFF_01'),
      tempPassword: optionalAccount('AUTH_TEMP_PASSWORD_01'),
      passwordRotate: optionalPasswordRotateAccount('AUTH_PASSWORD_ROTATE_01'),
    },
  }
}
