import type { DeployEnv } from './env'
import {
  provisionThrowawayOwner,
  loginViaApi,
  completePasswordChangeViaApi,
  createEmployeeViaApi,
  randomToken,
  randomPassword,
} from './provisioning'

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

// FE-BE-014 전용 — OWNER/MANAGER/STAFF 세 계정을 전부 "비밀번호 변경 완료" 상태까지 준비해서
// 돌려준다. 실제 화면 검증(Playwright page)은 호출부가 하고, 이 함수는 그 전에 필요한 계정
// 준비만 Node fetch로 직접 한다.
export async function setupRoleFixtures(env: DeployEnv): Promise<RoleFixtures> {
  const tenantCode = `e2e-role-${randomToken().slice(0, 10)}`

  const ownerTemp = randomPassword('Fixture014Temp')
  await provisionThrowawayOwner(env, {
    tenantCode,
    tenantName: 'Doro E2E FE-BE-014 Fixture',
    storeName: 'Doro E2E FE-BE-014 Store',
    loginId: 'owner',
    temporaryPassword: ownerTemp,
  })

  const ownerTempLogin = await loginViaApi(env, tenantCode, 'owner', ownerTemp)
  if (ownerTempLogin.status !== 200) {
    throw new Error(`OWNER 임시 로그인 실패 (status=${ownerTempLogin.status})`)
  }

  const ownerPermanent = randomPassword('Fixture014Perm')
  await completePasswordChangeViaApi(env, ownerTempLogin.cookies, ownerTemp, ownerPermanent)

  // 비밀번호 변경은 성공 즉시 그 계정의 기존 Session을 전부 무효화한다(SESS-005/AUTH-013·014에서
  // 이미 확인) — 그래서 직원 생성을 부르려면 새 비밀번호로 다시 로그인해서 새 Session을 받아야 한다.
  const ownerLogin = await loginViaApi(env, tenantCode, 'owner', ownerPermanent)
  if (ownerLogin.status !== 200) {
    throw new Error(`OWNER 재로그인 실패 (status=${ownerLogin.status})`)
  }

  async function createReadyEmployee(role: 'MANAGER' | 'STAFF'): Promise<RoleAccount> {
    const loginId = `${role.toLowerCase()}014${randomToken().slice(0, 6)}`
    const temp = randomPassword(`Fixture014${role}Temp`)
    await createEmployeeViaApi(env, ownerLogin.cookies, { loginId, temporaryPassword: temp, role })

    const employeeTempLogin = await loginViaApi(env, tenantCode, loginId, temp)
    if (employeeTempLogin.status !== 200) {
      throw new Error(`${role} 임시 로그인 실패 (status=${employeeTempLogin.status})`)
    }
    const permanent = randomPassword(`Fixture014${role}Perm`)
    await completePasswordChangeViaApi(env, employeeTempLogin.cookies, temp, permanent)

    return { tenantCode, loginId, password: permanent }
  }

  const manager = await createReadyEmployee('MANAGER')
  const staff = await createReadyEmployee('STAFF')

  return {
    owner: { tenantCode, loginId: 'owner', password: ownerPermanent },
    manager,
    staff,
  }
}
