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

export interface ProvisioningConfig {
  origin: string | null
  username: string | null
  password: string | null
}

export interface DeployEnv {
  environment: string
  frontendOrigin: string
  apiOrigin: string
  authValid01: AccountFixture
  deployment: DeploymentIdentity
  provisioning: ProvisioningConfig
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
    // FE-BE-010/014 전용 — 없으면 그 케이스들만 SKIP_PRECONDITION (lib/provisioning.ts 참고).
    // api/lib/env.js의 같은 필드와 대응된다.
    provisioning: {
      origin: process.env.PROVISIONING_ORIGIN ?? null,
      username: process.env.STORE_ACCESS_PROVISIONING_USERNAME ?? null,
      password: process.env.STORE_ACCESS_PROVISIONING_PASSWORD ?? null,
    },
  }
}
