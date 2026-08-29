# 결과 로그 공용 스키마

`browser/lib/resultLogger.ts`와 `api/lib/resultLogger.js` + `api/lib/report.js`가 각자의 런타임(Node/Playwright, k6)에
맞게 독립 구현하지만 반드시 동일하게 유지해야 하는 필드 계약. 이 스키마는 두 구현의 실제 코드가 정본이며,
이 문서는 그 요약이자 두 구현이 갈라지지 않았는지 비교하는 체크리스트다.

## 케이스 레코드 (JSONL 한 줄)

| 필드 | 타입 | 비고 |
|---|---|---|
| `schemaVersion` | number | 항상 `1` |
| `runId` | string | Playwright는 `global-setup.ts`, k6는 `DORO_RUN_ID`/자동 생성 |
| `testCaseId` | string | 예: `FE-BE-002`, `AUTH-001` |
| `testCaseAttempt` | number | 기본 `1`. 재시도 추적은 아직 미구현(README 참고) |
| `layer` | string | `FRONTEND_E2E` 또는 `API_DIRECT` |
| `resultCode` | enum | 아래 §resultCode 참고 |
| `startedAt` / `durationMs` | string(ISO) / number | |
| `environment` / `targetHost` | string | |
| `deployment` | object | `frontendRevision`, `cloudFrontDistributionId`, `edgeRevision`, `storeAccessRevision` — 미주입 시 `"unknown"` |
| `accountAlias` | string \| null | `AUTH_VALID_01` 등, 원문 tenantCode/loginId 아님 |
| `expected` / `observed` | object | 케이스별로 관련 필드만 채움. 예: FE-BE-003은 `loginStatus`·`protectedApiRequestSent`·`protectedApiStatus`를 기록해 로그인 실패·요청 미전송·응답 미수신을 구분한다. |
| `requestId` | string \| null | 응답 `X-Request-Id` |
| `assertions` | object | boolean 위주, 케이스별 세부 판정 |
| `browser` | object | browser 전용: `consoleErrorCount`/`pageErrorCount`/`failedRequiredRequestCount`. 원인 추적 케이스만 민감정보를 제거한 `consoleErrors`, 동일 Origin의 상태·경로만 담은 `httpErrorPaths` 배열을 선택적으로 기록 가능 |
| `artifacts.failureScreenshot` | string \| null | 아직 미구현 — 항상 `null` |
| `errorClass` | string \| null | 아래 errorCode 표 또는 `ASSERTION_MISMATCH` |

## resultCode

`PASS`, `FAIL_ASSERTION`, `FAIL_UI`, `FAIL_NETWORK_MAPPING`, `FAIL_PROTECTED_FLOW`, `ERROR_TRANSPORT`, `ERROR_CONFIG`, `SKIP_PRECONDITION`, `ABORT_SAFETY`

## 절대 기록하지 않는 값 (배포 Frontend–Backend 종단 검증.md §2, §8)

Password, Cookie/Session/CSRF Token 원문, tenantCode/loginId 원문(항상 `accountAlias`로 대체), 응답 Body 전체, 전체 Header.

## 알려진 편차

- k6는 `record()` 호출마다 `console.log(JSON.stringify(entry))`로 즉시 한 줄씩 stdout에 내보낸다
  (browser는 파일에 직접 즉시 append). 처음엔 k6도 browser처럼 모듈 스코프 배열에 모았다가
  `handleSummary()`에서 flush하도록 짰었는데, **k6의 `handleSummary()`는 VU 실행과 완전히 격리된
  별도 JS VM 인스턴스에서 돈다** — 그래서 VU가 쌓은 배열이 `handleSummary()` 쪽에서는 항상 빈
  배열로 보였다(로컬 리허설에서 `totalCases: 0`으로 실제 재현·확인). k6에는 이 경계를 우회할
  core API가 없어서, `k6 run --log-format=raw`로 찍은 stdout을 `api/lib/build-report.mjs`(평범한
  Node 스크립트)가 후처리해서 summary.json/junit.xml을 만드는 구조로 다시 짰다.
- 같은 이유로 k6 결과 파일은 `reports/<runId>/results.jsonl`처럼 하위 디렉터리를 쓰지 않고
  `reports/<runId>.<suite>.results.jsonl`처럼 `reports/` 바로 아래 평평한 파일명을 쓴다 — k6
  core JS에는 mkdir API가 없어서 없는 하위 디렉터리를 handleSummary 반환값으로 가리키면 조용히
  쓰기 실패만 하고(이것도 로컬 리허설에서 실제 재현·확인), Node 쪽(`build-report.mjs`)은 `fs`가
  있어 문제없다.
- 러너별 `summary.json`의 최상위 필드명이 다르다 — browser는 `mandatoryBrowserPassed`, api는
  `mandatoryApiPassed`. `scripts/reporting/build-combined-summary.mjs <runId>`(browser/api가 같은 `DORO_RUN_ID`로
  실행됐다는 전제)가 둘을 읽어 `reports/<runId>.combined-summary.json`에 `frontBackConnected`를
  계산해 넣지만, 이건 배포 Frontend–Backend 종단 검증.md §7 전체 판정식(`deploymentIdentityComplete`·
  `protectedApiReachedFromBrowser`·`requestCorrelationVerified`·`browserErrorsAbsent`까지 포함)이
  아니라 "필수 케이스 전부 PASS + 민감정보 유출 0건"만 보는 좁은 판정이다 — 그 결과의
  `caveats` 필드에 아직 반영 안 한 조건을 그대로 적어둔다.
