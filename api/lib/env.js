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

// Provisioning API 대신 미리 만들어둔 전용 계정 6개 — Docs/Specifications/운영·배포/
// "배포 검증용 테스트 계정 요청.md" 참고. 하나라도 env에 없으면 null — 호출부는 Provisioning
// 경로로 자연스럽게 폴백한다. browser/lib/env.ts의 같은 필드와 대응된다.
function optionalAccount(prefix) {
  const tenantCode = __ENV[`DORO_${prefix}_TENANT_CODE`]
  const loginId = __ENV[`DORO_${prefix}_LOGIN_ID`]
  const password = __ENV[`DORO_${prefix}_PASSWORD`]
  if (!tenantCode || !loginId || !password) return null
  return { tenantCode, loginId, password }
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
    // SESS-004/005 전용 — 없으면 그 두 케이스만 SKIP_PRECONDITION (lib/provisioning.js 참고).
    provisioning: {
      origin: __ENV.PROVISIONING_ORIGIN || null,
      username: __ENV.STORE_ACCESS_PROVISIONING_USERNAME || null,
      password: __ENV.STORE_ACCESS_PROVISIONING_PASSWORD || null,
    },
    staticAccounts: {
      lockout: optionalAccount('AUTH_LOCKOUT_01'),
      inactiveEmployee: optionalAccount('AUTH_INACTIVE_EMPLOYEE_01'),
      inactiveTenant: optionalAccount('AUTH_INACTIVE_TENANT_01'),
      roleOwner: optionalAccount('AUTH_ROLE_OWNER_01'),
      roleManager: optionalAccount('AUTH_ROLE_MANAGER_01'),
      roleStaff: optionalAccount('AUTH_ROLE_STAFF_01'),
    },
  }
}
