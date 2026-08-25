import type { DeployEnv } from './env'

export interface RoleAccount {
  tenantCode: string
  loginId: string
  password: string
}

export interface RoleFixtures {
  owner: RoleAccount
  manager: RoleAccount
  staff: RoleAccount
}

// FE-BE-014 전용 — OWNER/MANAGER/STAFF 세 계정을 돌려준다. AUTH_ROLE_OWNER_01/MANAGER_01/
// STAFF_01 정적 계정이 셋 다 있을 때만 호출된다 — 호출부(fe-be-conditional.spec.ts)가 미리
// 확인하고 없으면 SKIP_PRECONDITION으로 건너뛴다. 실 배포 대상 테넌트 DB에 Provisioning API로
// 1회용 Fixture를 만드는 폴백은 없다(Docs/Specifications/운영·배포/
// "배포 검증용 테스트 계정 요청.md" 참고).
export async function setupRoleFixtures(env: DeployEnv): Promise<RoleFixtures> {
  const { roleOwner, roleManager, roleStaff } = env.staticAccounts
  if (!roleOwner || !roleManager || !roleStaff) {
    throw new Error('AUTH_ROLE_OWNER_01/MANAGER_01/STAFF_01 정적 계정이 모두 필요합니다')
  }
  return { owner: roleOwner, manager: roleManager, staff: roleStaff }
}
