export interface AccountFixture {
  tenantCode: string
  loginId: string
  password: string
}

export interface DeploymentIdentity {
  frontendRevision: string
  cloudFrontDistributionId: string
  edgeRevision: string
  storeAccessRevision: string
}

export interface PasswordRotateAccountFixture {
  tenantCode: string
  loginId: string
  passwordA: string
  passwordB: string
}

// 실 배포 대상 테넌트 DB에 Provisioning API로 계정을 만들지 않기로 했다 — 미리 만들어둔 전용
// 계정 8개만 쓴다. Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md"에 정확한
// 요구사항을 정리해뒀다. 하나라도 env에 없으면 null — 호출부는 해당 케이스를
// SKIP_PRECONDITION으로 건너뛴다(Provisioning 폴백 없음).
export interface StaticAccounts {
  lockout: AccountFixture | null // AUTH_LOCKOUT_01 — AUTH-015/030/031
  inactiveEmployee: AccountFixture | null // AUTH_INACTIVE_EMPLOYEE_01 — AUTH-013
  inactiveTenant: AccountFixture | null // AUTH_INACTIVE_TENANT_01 — AUTH-014
  roleOwner: AccountFixture | null // AUTH_ROLE_OWNER_01 — FE-BE-014
  roleManager: AccountFixture | null // AUTH_ROLE_MANAGER_01 — FE-BE-014
  roleStaff: AccountFixture | null // AUTH_ROLE_STAFF_01 — FE-BE-014
  tempPassword: AccountFixture | null // AUTH_TEMP_PASSWORD_01 — FE-BE-010, SESS-004
  passwordRotate: PasswordRotateAccountFixture | null // AUTH_PASSWORD_ROTATE_01 — SESS-005
}

export interface DeployEnv {
  environment: string
  frontendOrigin: string
  apiOrigin: string
  authValid01: AccountFixture
  deployment: DeploymentIdentity
  staticAccounts: StaticAccounts
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new ConfigError(`${name} 환경변수가 없습니다 (ERROR_CONFIG)`)
  }
  return value
}

// 실제 배포 대상은 항상 HTTPS를 강제한다(배포 Frontend–Backend 종단 검증.md §2 즉시 중단 조건). 로컬 Docker
// prod-like 리허설(README "로컬 Docker Prod-like 리허설 모드" 참고)에서만, DORO_ENVIRONMENT가
// "local"로 시작하는 경우에 한해 http://localhost 를 예외로 허용한다 — Vite dev 서버가 평문
// HTTP로만 뜨기 때문이다. 이 예외는 실제 dev/stage/prod Origin에는 적용되지 않는다.
function requireOrigin(name: string, value: string, environment: string): string {
  const isLocalRehearsal = environment.startsWith('local')
  const isLocalHttp = value.startsWith('http://localhost:') || value === 'http://localhost'
  if (!value.startsWith('https://') && !(isLocalRehearsal && isLocalHttp)) {
    throw new ConfigError(
      `${name}=${value} 는 HTTPS가 아닙니다 (ERROR_CONFIG, 배포 Frontend–Backend 종단 검증.md §2 즉시 중단 조건). ` +
        'http://localhost 예외는 DORO_ENVIRONMENT가 "local"로 시작할 때만 적용된다.',
    )
  }
  return value.replace(/\/$/, '')
}

// tenantCode/loginId/password 셋 중 하나라도 없으면 null — required()처럼 강제하지 않는다,
// 이 계정들은 있으면 쓰고 없으면 Provisioning으로 폴백하는 선택 사항이라서다.
function optionalAccount(prefix: string): AccountFixture | null {
  const tenantCode = process.env[`DORO_${prefix}_TENANT_CODE`]
  const loginId = process.env[`DORO_${prefix}_LOGIN_ID`]
  const password = process.env[`DORO_${prefix}_PASSWORD`]
  if (!tenantCode || !loginId || !password) return null
  return { tenantCode, loginId, password }
}

// AUTH_PASSWORD_ROTATE_01 전용 — 비밀번호가 A/B 두 값이라 optionalAccount()로는 못 읽는다
// (SESS-005가 매번 현재 비밀번호를 스스로 판별해 반대쪽으로 바꾼다).
function optionalPasswordRotateAccount(prefix: string): PasswordRotateAccountFixture | null {
  const tenantCode = process.env[`DORO_${prefix}_TENANT_CODE`]
  const loginId = process.env[`DORO_${prefix}_LOGIN_ID`]
  const passwordA = process.env[`DORO_${prefix}_PASSWORD_A`]
  const passwordB = process.env[`DORO_${prefix}_PASSWORD_B`]
  if (!tenantCode || !loginId || !passwordA || !passwordB) return null
  return { tenantCode, loginId, passwordA, passwordB }
}

export function loadDeployEnv(): DeployEnv {
  const environment = process.env.DORO_ENVIRONMENT ?? 'dev'
  const frontendOrigin = requireOrigin('DORO_FRONTEND_ORIGIN', required('DORO_FRONTEND_ORIGIN'), environment)
  const apiOrigin = requireOrigin('DORO_API_ORIGIN', required('DORO_API_ORIGIN'), environment)

  if (frontendOrigin !== apiOrigin) {
    throw new ConfigError(
      `DORO_FRONTEND_ORIGIN(${frontendOrigin})과 DORO_API_ORIGIN(${apiOrigin})이 다릅니다. ` +
        '배포 Frontend–Backend 종단 검증.md §2: 동일 Origin 구조가 아니면 승인된 구조인지 확인 없이 실행을 중단한다.',
    )
  }

  return {
    environment,
    frontendOrigin,
    apiOrigin,
    authValid01: {
      tenantCode: required('DORO_AUTH_VALID_01_TENANT_CODE'),
      loginId: required('DORO_AUTH_VALID_01_LOGIN_ID'),
      password: required('DORO_AUTH_VALID_01_PASSWORD'),
    },
    deployment: {
      frontendRevision: process.env.DORO_FRONTEND_REVISION ?? 'unknown',
      cloudFrontDistributionId: process.env.DORO_CLOUDFRONT_DISTRIBUTION_ID ?? 'unknown',
      edgeRevision: process.env.DORO_EDGE_REVISION ?? 'unknown',
      storeAccessRevision: process.env.DORO_STORE_ACCESS_REVISION ?? 'unknown',
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
