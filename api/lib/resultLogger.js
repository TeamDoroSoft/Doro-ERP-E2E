// k6는 `handleSummary()`를 VU가 테스트를 돌린 것과는 "별도의 격리된 JS VM 인스턴스"에서 실행한다
// (goja 런타임을 아예 새로 만들어서 호출) — 그래서 VU 실행 중 모듈 스코프 배열에 push해둔
// 값은 handleSummary() 쪽에서는 전부 비어 있는 새 배열로 보인다. 로컬 리허설에서 실제로
// `totalCases: 0`으로 재현·확인했다. 이 경계를 우회할 방법이 core k6 JS API엔 없으므로,
// 배열에 모아뒀다가 나중에 flush하는 대신 케이스마다 즉시 console.log로 한 줄씩 내보낸다.
// `k6 run --log-format=raw`로 실행하면 이 JSON 줄이 그대로(k6 자체 로그 접두어 없이) stdout에
// 찍히고, `api/lib/build-report.mjs`가 그 stdout을 읽어 summary.json/junit.xml을 만든다
// (README·api/README.md 참고).
export function record(env, input) {
  const entry = {
    schemaVersion: 1,
    runId: env.runId,
    testCaseId: input.testCaseId,
    testCaseAttempt: input.testCaseAttempt || 1,
    layer: 'API_DIRECT',
    resultCode: input.resultCode,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    environment: env.environment,
    targetHost: env.apiOrigin.replace(/^https?:\/\//, ''),
    deployment: env.deployment,
    accountAlias: input.accountAlias || null,
    expected: input.expected || {},
    observed: input.observed || {},
    requestId: input.requestId || null,
    assertions: input.assertions || {},
    artifacts: { failureScreenshot: null },
    errorClass: input.errorClass || null,
  }
  console.log(JSON.stringify(entry))
  return entry
}
