// 실 배포 대상 테넌트 DB에 Provisioning API로 계정을 만드는 걸 금지하기로 했다 — 이 파일이
// 예전에 갖고 있던 provisioningAvailable/provisionThrowawayOwner/createEmployee/
// changeEmployeeStatus/changeTenantStatus/completePasswordChange(전부 Provisioning API 또는
// 그걸로 만든 Fixture를 조작하는 함수)는 전부 제거했다. AUTH-013/014/015, AUTH-030/031,
// FE-BE-014는 이제 미리 만들어둔 정적 계정만 쓴다
// (Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md" 참고). 이 파일엔 Provisioning과
// 무관한 범용 유틸(임의 문자열 생성)만 남는다.

export function randomToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

// PasswordPolicyValidator.MIN_LENGTH = 15. 무작위 문자열이라 블록리스트·서비스 파생어 회피에
// 유리하다 (provision-local-rehearsal-account.mjs와 같은 접근).
export function randomPassword(prefix) {
  return `${prefix}-${randomToken()}`
}
