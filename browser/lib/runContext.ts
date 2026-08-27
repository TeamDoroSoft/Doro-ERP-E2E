// UTC+9(Asia/Seoul, DST 없음) 고정 오프셋으로 KST 벽시계 값을 얻는다 — scripts/lib/gate-steps.mjs의
// ensureRunId()와 같은 형식·같은 트릭을 쓴다(둘 다 DORO_RUN_ID를 만들 수 있는데, 보통은
// run-mandatory-gate.mjs가 먼저 만든 값을 이 프로세스가 환경변수로 물려받아 쓰고, 이 함수는
// DORO_RUN_ID 없이 Playwright를 단독 실행했을 때만 쓰이는 폴백이다 — 두 값의 형식이 다르면
// 혼란스러우니 맞춰둔다).
function kstTimestamp(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = kst.getUTCFullYear()
  const mo = pad(kst.getUTCMonth() + 1)
  const d = pad(kst.getUTCDate())
  const h = pad(kst.getUTCHours())
  const mi = pad(kst.getUTCMinutes())
  const s = pad(kst.getUTCSeconds())
  return `${y}-${mo}-${d}_${h}-${mi}-${s}`
}

export function makeRunId(prefix = 'run'): string {
  // 단독 실행 시 같은 초에 두 번 돌아도 폴더가 안 겹치도록 짧은 무작위 접미사를 남긴다
  // (run-mandatory-gate.mjs 경유일 때는 DORO_RUN_ID가 이미 있어서 이 함수 자체가 안 불린다).
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${kstTimestamp()}-${rand}`
}
