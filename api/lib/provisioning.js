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

// k6는 Node가 아니라 goja 런타임이라 crypto.randomUUID()가 없다. QUEUE-003(Idempotency-Key)처럼
// 서버가 실제 UUID 형식을 요구하는 자리에 쓸 최소 UUID v4 생성기 — 외부 의존성 없이
// Math.random()만으로 RFC 4122 버전/변형 비트를 채운다. 암호학적 品質은 필요 없는 자리
// (테스트 요청 식별자)라 Math.random()으로 충분하다.
export function randomUuidV4() {
  const hex = []
  for (let i = 0; i < 256; i++) hex[i] = (i < 16 ? '0' : '') + i.toString(16)
  const bytes = new Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10xx
  const h = bytes.map((b) => hex[b])
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
}

// PasswordPolicyValidator.MIN_LENGTH = 15. 무작위 문자열이라 블록리스트·서비스 파생어 회피에
// 유리하다 (provision-local-rehearsal-account.mjs와 같은 접근).
export function randomPassword(prefix) {
  return `${prefix}-${randomToken()}`
}
