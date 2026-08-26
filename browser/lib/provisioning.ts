import type { DeployEnv } from './env'

// 실 배포 대상 테넌트 DB에 Provisioning API로 계정을 만드는 걸 금지하기로 했다 — 이 파일이
// 예전에 갖고 있던 provisionThrowawayOwner/loginViaApi/completePasswordChangeViaApi/
// createEmployeeViaApi(전부 Provisioning API 또는 그걸로 만든 Fixture를 조작하는 함수)는
// 전부 제거했다. FE-BE-010/014는 이제 미리 만들어둔 정적 계정만 쓴다
// (Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md" 참고). 이 파일엔 Provisioning과
// 무관한 범용 유틸(자체 서명 인증서 예외, 임의 문자열 생성)만 남는다.

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
