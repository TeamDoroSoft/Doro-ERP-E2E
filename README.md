# doro-erp-e2e

`배포 Frontend–Backend 종단 검증`
(`ERP/Docs/Specifications/운영·배포/배포 Frontend–Backend 종단 검증.md`)을 구현하는 배포 종단(End-to-End) 테스트 러너.

`Doro-ERP-Front`, `Doro-ERP-Infra`, `Doro-ERP-Service`, `Docs`, `Doro-ERP-GitOps`와 마찬가지로 독립 git 저장소이며,
`Final_Project/CLAUDE.md`의 브랜치 네이밍(`feature/`, `bugfix/`, `refactor/`, `hotfix/`)과 리뷰 워크플로우(Claude 구현 → Codex 로컬 diff 리뷰)를 동일하게 따른다.

## 구조

```
doro-erp-e2e/
├── browser/            # Playwright 배포 E2E — FE-BE-* (실제 배포 화면, Network 관찰 포함)
│   ├── tests/
│   └── lib/
├── api/                # k6 배포 API Runner — AUTH-*, SESS-*, OPS-*, QUEUE-*, CATALOG-*
│   ├── scenarios/
│   └── lib/
├── shared/             # 두 러너가 공유하는 결과 스키마/판정 규칙 정의 (이 저장소 자체가 정본)
├── reports/            # 실행 산출물 (runId별, gitignore 대상)
├── .env.deploy-e2e.example   # 환경변수 템플릿 (플레이스홀더만, 실값 커밋 금지)
```

`browser`(Playwright)와 `api`(k6)를 같은 저장소 안에 두되 도구는 분리한다 — k6 Browser 모듈은 `page.on('request')`/`page.route()`/CDP 접근을 지원하지 않아
`FE-BE-002`~`006`이 요구하는 Network 계층 관찰(배포 Frontend–Backend 종단 검증.md §3)을 충족할 수 없기 때문 ([grafana/k6#4020](https://github.com/grafana/k6/issues/4020)). 자세한 도구 선정 근거는 같은 문서 §2.1 참고.

## 구현 범위 (현재)

**필수 Gate + SESS-004/005** — `browser/tests/fe-be-mandatory.spec.ts`(`FE-BE-001`~`006`), `api/scenarios/auth-mandatory.js`(`AUTH-001`~`004`,`010`,`020`~`024`), `api/scenarios/session-flow.js`(`SESS-001`,`002`,`003`,`004`,`005`,`006`,`007`).
`SESS-004`/`005`는 `AUTH_VALID_01`이 아니라 전용 정적 계정을 쓴다 — `SESS-004`는 `AUTH_TEMP_PASSWORD_01`,
`SESS-005`는 `AUTH_PASSWORD_ROTATE_01`(비밀번호 A/B 두 값 중 지금 어느 쪽이 현재 값인지 스스로 판별해
반대쪽으로 바꾼다). 실 배포 대상 테넌트 DB에 Provisioning API로 계정을 만들지 않기로 했다 — 해당
정적 계정이 없으면 그 케이스만 `SKIP_PRECONDITION`으로 건너뛴다(아래 "주의사항" 참고).
`SESS-006`/`007`은 Edge-HMAC 보호 대상이 된 `/api/v1/auth/reauthenticate`의 성공 시 Session 회전과
5회 실패 시 계정 잠금 없이 해당 Session만 무효화되는 동작을 각각 검증한다.

두 러너 결과를 하나로 묶는 `scripts/build-combined-summary.mjs`도 추가했다 — browser/api 실행에 같은
`DORO_RUN_ID`를 지정해야 서로 짝지어진다(아래 "실행" 참고).

개별 스위트를 한 번에 이어 실행하는 `scripts/run-mandatory-gate.mjs`와 `scripts/run-full-gate.mjs`도
추가했다. 포함 범위와 파괴적 항목 안전장치는 아래 "오케스트레이션 스크립트 사용법" 참고.

**`queue-api`(대기열)와 `commerce-api` Catalog 도메인 연결성 검증(`QUEUE-001`~`003`,`CATALOG-001`~`006`)도
추가했다** — 배포 Frontend–Backend 종단 검증.md §10. Tier A(`QUEUE-001`/`002`,`CATALOG-001`~`003`)는
`AUTH_VALID_01` 별칭으로 항상 실행하고, Tier B의 `CATALOG-004`~`006`은 `AUTH_ROLE_OWNER_01` 별칭을
쓴다. 2026-08-26부터 두 별칭은 같은 물리 계정을 가리킨다(아래 설명 참고).

**`audit-api`(감사 로그)와 `commerce-api` sales 도메인 연결성 검증(`AUDIT-001`,`SALES-001`)도
추가했다** — 같은 §10. 둘 다 Tier A(비파괴 조회)이고 `AUTH_VALID_01` 하나만으로 실행된다. 별도
파일(`api/scenarios/audit-sales-connectivity.js`)로 합쳐뒀다 — 이유는 아래 "⚠️ 계정 Rate Limit
Bucket 주의"와 `api/README.md` 참고. `ORDER-001`은 §10 정의 검토 과정에서 `SESS-001`과 완전히
같은 성격(단일 인증 GET으로 Edge 라우팅 확인)이라 중복으로 판단해 별도 구현 없이 폐기했다.

| ID | Tier | 시나리오 | 구현 위치 |
|---|---|---|---|
| `QUEUE-001` | A | `GET /api/v1/queues/fulfillment` `200` | `api/scenarios/queue-connectivity.js` |
| `QUEUE-002` | A | `GET /api/v1/queues/entry?businessDate=<오늘>` `200` | `api/scenarios/queue-connectivity.js` |
| `QUEUE-003` | B | Entry 등록 → `WAITING` 확인 → 취소 → `CANCELLED` 확인 → 재취소 충돌(`409`) | `api/scenarios/queue-connectivity.js`(`RUN_DESTRUCTIVE_QUEUE_TESTS=true` 필요) |
| `CATALOG-001` | A | `GET /api/v1/catalog/menu` `200` | `api/scenarios/catalog-connectivity.js` |
| `CATALOG-002` | A | `GET /api/v1/catalog/categories` `200` | `api/scenarios/catalog-connectivity.js` |
| `CATALOG-003` | A | `GET /api/v1/catalog/products` `200` | `api/scenarios/catalog-connectivity.js` |
| `CATALOG-004` | B | Category 생성 → 목록 확인 → `PATCH`+`If-Match` 수정 → 확인 → 비활성화 | `api/scenarios/catalog-connectivity.js`(`RUN_DESTRUCTIVE_CATALOG_TESTS=true` 필요) |
| `CATALOG-005` | B | 전용 Category 생성 → Product 생성 → 목록 확인 → 수정 → 확인 → 상품·Category 비활성화 | `api/scenarios/catalog-connectivity.js`(`RUN_DESTRUCTIVE_CATALOG_TESTS=true` 필요) |
| `CATALOG-006` | B | 품절 `true`→확인→`false`→확인(`CATALOG-005`의 Product 재사용, 완전 가역) | `api/scenarios/catalog-connectivity.js`(`RUN_DESTRUCTIVE_CATALOG_TESTS=true` 필요) |
| `AUDIT-001` | A | `GET /api/v1/audits?from=...&to=...`(최근 1시간) `200` — `from`/`to` 필수, OWNER/MANAGER만 허용 | `api/scenarios/audit-sales-connectivity.js` |
| `SALES-001` | A | `GET /api/v1/sales/daily?businessDate=<오늘>` `200` — KST 자정 전후 5분은 `SKIP_PRECONDITION` | `api/scenarios/audit-sales-connectivity.js` |

`QUEUE-003`은 취소된 Entry 행과 대기 순번 소비를 실 테넌트 데이터에 영구히 남기는 상태 변경 흐름이라
`RUN_DESTRUCTIVE_QUEUE_TESTS=true`를 명시해야 실행된다 — `AUTH-030`~`034`가 쓰는
`RUN_DESTRUCTIVE_AUTH_TESTS`는 인증 도메인 전용 위험(계정 잠금·Rate Limit)을 이름에 명시한 플래그라
대기열 도메인 상태 변경에 재사용하지 않고 별도 플래그를 뒀다. `CATALOG-004`~`006`도 같은 이유로
`RUN_DESTRUCTIVE_CATALOG_TESTS`라는 Catalog 도메인 전용 플래그를 별도로 뒀다 — 셋 다 하나로 묶은
이유는 `CATALOG-006`(가역)조차 `CATALOG-005`가 만든 Product 없이는 단독 실행이 불가능해서
독립적으로 켜고 끌 실익이 없기 때문이다.

> ~~과거 결정: `CATALOG-004`~`006`은 `CATALOG-001`~`003`과 달리 `AUTH_VALID_01`(실 데모 테넌트
> `sample-store`)이 아니라 `AUTH_ROLE_OWNER_01`(실 고객이 없는 합성 테넌트 `e2e-auth-active`)로
> 로그인한다 — `DELETE` Endpoint가 없어 생성한 Category·Product가 영구히 남기 때문에, 그 잔여물을
> 실 데모 데이터가 아니라 전용 합성 테넌트에만 남기기 위해서다.~~

2026-08-26 결정으로, 부트캠프 규모에서 별도 계정을 새로 요청하지 않고 이미 확보한
`AUTH_ROLE_OWNER_01`(`e2e-auth-active`/`e2e-role-owner`)을 `AUTH_VALID_01` 역할까지 겸용한다. 두 별칭은
같은 물리 계정이므로 계정 단위 Rate Limit Bucket도 공유한다.
자세한 내용은 `api/README.md` 참고.

**잠금·Rate Limit(`AUTH-030`,`031`,`033`,`034`)과 장애 주입(`OPS-001`,`003`)도 추가했다** — 기본으로는
실행되지 않는다(안전 장치):

- `api/scenarios/auth-lockout-ratelimit.js`는 `RUN_DESTRUCTIVE_AUTH_TESTS=true`를 명시해야 실행된다.
  `AUTH-030`/`031`(5회 실패 계정 잠금)은 `AUTH_LOCKOUT_01` 정적 계정을 쓴다 — 없으면 폴백 없이
  `SKIP_PRECONDITION`이다.
  **실측으로 확인한 중요한 사실**: 계정 Rate Limit Bucket 용량(5)이 잠금 임계치(5회)와 정확히 같아서,
  "잠금 직후" 요청은 문서가 적은 `401`이 아니라 `429 AUTH_RATE_LIMITED`로 막힌다(Bucket이 먼저
  소진되기 때문) — 둘 다 "안전하게 거절, 상세 비노출"이라는 실제 의도는 만족하므로 `AUTH-031`은
  이 두 상태 모두를 PASS로 받아들이도록 짰다. 자세한 내용은 스크립트 안의 주석과 `api/README.md` 참고.
- `scripts/run-fault-injection.mjs OPS-001|OPS-003 --confirm`은 로컬 Docker 컨테이너
  (`store-access-api`/`redis`)를 실제로 멈췄다 올리며 `503` Fail-Closed와 복구를 확인한다.
  `--confirm` 없이는 무엇도 건드리지 않고 즉시 종료한다.
- **`scripts/verify-edge-boundary.mjs`(`OPS-004`)**는 인프라를 바꾸지 않는 비파괴·읽기 전용 검사로,
  유효한 TLS와 CloudFront→ALB→Edge API 공개 경로 및 내부 Ingress 직접 접근 차단을 확인한다.
  2026-08-25 `team2` Profile로 실제 AWS 배포에 실행해 `PASS`를 확인했다(아래 "Deployment Identity(Revision) 채우기" 참고).
  이후 TLS/네트워크 오류를 구분하는 분기가 추가됐는데 이 부분은 아직 실 클러스터로 검증 못했다(아래 "주의사항" 참고).
- **`scripts/verify-provider-malformed-response.mjs`(`OPS-002`)**는 `kubectl`로 실 `store-access-api`
  Service의 `spec.selector`를 의도적으로 잘못된 로그인 응답을 내는 임시 디코이 Pod로 바꿔 Edge API가
  `503` Fail-Closed하는지 확인한 뒤 원복한다. `--confirm`이 필요하며, 실 실행은 아직 미검증이다
  (아래 "주의사항" 참고).
- **`scripts/verify-partial-pod-failure.mjs`(`OPS-005`)**는 `kubectl`로 두 `store-access-api` Pod 중
  하나를 삭제하고 Service Endpoint 제외, 남은 Pod의 정상 응답, Session 왕복 일관성, Deployment 복구를
  확인한다. `--confirm`이 필요하며, 실 실행은 아직 미검증이다(아래 "주의사항" 참고).

**계정 존재 비노출(`AUTH-011`~`015`)도 추가했다** — `api/scenarios/auth-account-nonexposure.js`.
`AUTH-011`/`012`(존재하지 않는 loginId/tenantCode)는 Fixture가 필요 없어 항상 실행되고,
`AUTH-013`(INACTIVE 직원)/`014`(INACTIVE 테넌트)는 각각 전용 정적 계정이 있으면 실행되고,
`AUTH-015`(잠금 상태)는 `auth-lockout-ratelimit.js`와 같은 이유로 `RUN_DESTRUCTIVE_AUTH_TESTS=true`도
추가로 요구한다. 구현 중 실제 버그 3개를 잡았다:
- `PasswordPolicyValidator`가 비밀번호에 `loginId`("owner")가 부분 문자열로 포함되면 거부한다 —
  `"Owner013"` 같은 접두어를 쓰다 `WEAK_PASSWORD 400`을 실제로 봤다.
- `EmployeeController`의 직원 생성/상태 변경은 행위자(OWNER) 본인이 이미 비밀번호를 바꿨을 것을
  요구한다 — 임시 비밀번호 상태로 바로 호출하면 `403 PASSWORD_CHANGE_REQUIRED`.
- 비밀번호 변경은 성공하는 순간 그 계정의 기존 Session을 전부 무효화한다(`SESS-005`가 검증하는 것과
  같은 동작) — 변경 직후 그 Session으로 다음 API를 부르면 `401 UNAUTHENTICATED`, 새 비밀번호로
  재로그인해야 한다.
- `AUTH-015`도 `AUTH-031`과 똑같은 현상을 보였다 — 5회 실패 직후 65초를 기다렸더니 계정 Bucket
  리필과 잠금 만료가 거의 동시에 풀려서 `200`(로그인 성공)이 나왔다. 기다리지 않고 5번째 실패
  직후 바로 확인하도록 다시 짜서, `AUTH-031`과 같은 기준(`401` 또는 `429` 둘 다 안전한 거절로 인정)을
  적용했다.

**실 배포용 정적 테스트 계정만 쓴다 — Provisioning API로 실 테넌트 DB에 계정을 만드는 경로는 전부
삭제했다.** `browser/lib/env.ts`의 `StaticAccounts`/`DeployEnv.staticAccounts`와 `api/lib/env.js`의
미러 구현이 `DORO_<ACCOUNT_PREFIX>_TENANT_CODE`/`_LOGIN_ID`/`_PASSWORD` 세 값을 모두 받으면 해당
계정을 활성화한다(예: `DORO_AUTH_LOCKOUT_01_TENANT_CODE`/`_LOGIN_ID`/`_PASSWORD`). 지원 prefix는
`AUTH_LOCKOUT_01`, `AUTH_INACTIVE_EMPLOYEE_01`, `AUTH_INACTIVE_TENANT_01`, `AUTH_ROLE_OWNER_01`,
`AUTH_ROLE_MANAGER_01`, `AUTH_ROLE_STAFF_01`, `AUTH_TEMP_PASSWORD_01`(3값), `AUTH_PASSWORD_ROTATE_01`
(예외적으로 4값 — `_PASSWORD_A`/`_PASSWORD_B`, `SESS-005`가 매번 현재 비밀번호를 스스로 판별해
반대쪽으로 바꾼다). `AUTH-013`/`014`/`015`, `AUTH-030`/`031`, `FE-BE-014`, `FE-BE-010`, `SESS-004`,
`SESS-005` 전부 해당 정적 계정이 없으면 **폴백 없이 곧바로** `SKIP_PRECONDITION`이다(`FE-BE-014`는
OWNER/MANAGER/STAFF 세 계정이 모두 있어야 실행). Provisioning API를 호출하면 실 테넌트 DB에 추적
안 되는 데이터가 생긴다는 이유로, 이 8개 케이스는 **로컬 리허설에서도** 더 이상 검증할 수 없다 —
이 리포는 처음부터 실 AWS 배포 검증이 목적이고 로컬 리허설은 스크립트 자체 버그를 미리 잡기 위한
부수적인 수단이라, 그 부수적인 용도를 위해 Provisioning 경로를 남겨두지 않기로 했다. 자세한 계정
요구사항은 `Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md"` 참고.

잠금 단계 증가(`AUTH-032`)는 실제 clock 대기 비용이 커서(십수 분) 없다. 조건부 화면 반응
(`FE-BE-010`~`015`, 배포 Frontend–Backend 종단 검증.md §4 "조건부 Browser 시나리오")은
`browser/tests/fe-be-conditional.spec.ts`에 6개 전부 구현했다. `FE-BE-011`/`012`/`013`/`015`는
로컬 리허설로 검증 완료했지만, `FE-BE-010`/`014`는 Provisioning 폴백을 제거하면서 전용 정적 계정
(`AUTH_TEMP_PASSWORD_01`, `AUTH_ROLE_OWNER_01`/`MANAGER_01`/`STAFF_01`) 전제로 코드가 바뀌어서
아직 실행 검증 전이다.

`scripts/resolve-deployment-identity.mjs`도 추가했다 — `deployment`(Revision) 4개 필드를
실제 AWS·GitOps에서 읽어와 `.env.deployment-identity.local`에 채운다. 자세한 내용은 바로 아래
"Deployment Identity(Revision) 채우기" 참고.

## 주의사항

- **AUTH-034 공유 네트워크 경고**: 위 명령을 실 배포(dev/stage/prod) 대상으로 바꿔서 돌릴 계획이라면 `AUTH-034`를 반드시 먼저 `api/README.md`의 경고를 읽을 것 — 공유 네트워크에서 돌리면 같은 IP를 쓰는 다른 실사용자까지 막힐 수 있다.
- **EKS 접근 미검증 경고**: `FE-BE-012`(`browser/tests/fe-be-conditional.spec.ts`)의 실 배포 경로, `scripts/run-fault-injection.mjs`의 `OPS-001`/`OPS-003`(로컬 전용, 실 배포 미대응), `scripts/verify-provider-malformed-response.mjs`(`OPS-002`), `scripts/verify-partial-pod-failure.mjs`(`OPS-005`)는 전부 실 EKS 클러스터 접근이 필요한데, 이 리포를 작업한 환경에는 그 접근 권한이 없어서 실제로 실행해 검증하지 못했다. 최초 실행 전 결과를 직접 확인해야 한다.
- **`OPS-005`는 파괴적이다**: 실제로 `store-access-api` Pod 1개를 `kubectl delete pod`로 지운다 — 승인된 점검 시간에만, `--confirm` 필요.
- **`OPS-002`는 영향 범위가 넓다**: 실 `store-access-api` Service의 `spec.selector`를 디코이 Pod로 임시 교체한다(재시작이 필요 없고 즉시 반영·즉시 원복되는 방식을 택했다). 다만 `STORE_ACCESS_INTERNAL_BASE_URL` 하나를 edge-api의 로그인·Session Context·Kiosk·Management·비밀번호 변경 Forwarder 6개가 전부 공유하기 때문에, 교체돼 있는 동안에는 store-access-api를 쓰는 edge-api의 모든 통신이 함께 영향을 받는다(`OPS-005`보다 넓은 범위) — 승인된 점검 시간에만, `--confirm` 필요.
- **정적 계정 8개 준비 필요, 없으면 SKIP만 하고 대체 경로 없음**: `AUTH-013`/`014`/`015`, `AUTH-030`/`031`, `FE-BE-010`/`014`, `SESS-004`/`005`는 전용 정적 계정이 없으면 `SKIP_PRECONDITION`으로만 끝난다 — Provisioning API 폴백을 완전히 제거했기 때문에(실 테넌트 DB에 추적 안 되는 데이터가 생기는 걸 막기 위함) 로컬 리허설로도 우회할 수 없다. 계정 요구사항은 `Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md"` 참고.
- **`OPS-005`의 `observedSinglePodWindow`는 보조 지표다**: PASS해도 이 값이 `false`면 대체 Pod가 너무 빨리 Ready가 돼서 "정말로 Pod 1개만 서비스하던 순간"을 직접 관측하지 못했다는 뜻이다(서비스가 계속 정상 응답했다는 핵심 판정 자체는 여전히 유효하다) — 결과를 엄격하게 확인해야 하면 JSONL의 이 필드를 같이 봐야 한다.
- **`OPS-004`의 TLS/네트워크 오류 구분 로직은 아직 실 클러스터로 검증 못함**: 내부 ALB가 실수로 인터넷에 노출된 경우(TLS 인증서 오류로 응답이 옴)와 정상적으로 차단된 경우(연결 자체가 실패)를 구분하도록 새로 추가했다 — 기존에 "2026-08-25 실 AWS 배포 PASS 확인"한 건 이 분기가 생기기 전 코드 기준이라, 이 분기 자체는 실제 TLS 오류 케이스로는 아직 검증되지 않았다.

## 오케스트레이션 스크립트 사용법

개별 스위트를 하나씩 손으로 이어붙이지 않도록 `scripts/run-mandatory-gate.mjs`와 `scripts/run-full-gate.mjs` 두 오케스트레이션 스크립트를 추가했다.

- **`node scripts/run-mandatory-gate.mjs`** — 아래 순서로 실행한다: `FE-BE-001`~`006`(Playwright `tests/fe-be-mandatory.spec.ts`) → `AUTH-001`~`004`,`010`,`020`~`024`(k6 `api/scenarios/auth-mandatory.js`) → `AUTH-011`~`015`(k6 `api/scenarios/auth-account-nonexposure.js`) → `SESS-001`~`003`,`006`,`007`(+`004`/`005` 조건부)(k6 `api/scenarios/session-flow.js`) → `QUEUE-001`~`002`(k6 `api/scenarios/queue-connectivity.js`) → `CATALOG-001`~`003`(k6 `api/scenarios/catalog-connectivity.js`) → `AUDIT-001`,`SALES-001`(k6 `api/scenarios/audit-sales-connectivity.js`) → `OPS-004`(`scripts/verify-edge-boundary.mjs`, 비파괴 관찰) → 종합 판정(`scripts/build-combined-summary.mjs`). 전부 파괴적 플래그 없이 안전 — CI에서 매 배포마다 완전 자동 실행해도 된다. `DORO_FRONTEND_ORIGIN`/`DORO_API_ORIGIN`/`DORO_AUTH_VALID_01_*` 등 필요한 값은 미리 export해둬야 한다(각 하위 실행이 `loadDeployEnv()`로 직접 요구). `QUEUE-001`~`002`/`CATALOG-001`~`003` 단계는 `session-flow.js` 직후 `AUTH_VALID_01` 로그인을 1회씩 더 쓰고, 그 뒤 `AUDIT-001`/`SALES-001` 단계는 별도 프로세스(별도 파일)라 로그인이 1회 더 필요해 그 앞에서 5분을 추가로 대기한다 — 이 순서를 바꾸지 말 것(아래 "⚠️ 계정 Rate Limit Bucket 주의"·`api/README.md` 참고).
- **`node scripts/run-full-gate.mjs`** — 위 전체 + `QUEUE-003`(안내만 출력 — `RUN_DESTRUCTIVE_QUEUE_TESTS=true`면 위 `run-mandatory-gate.mjs`의 `queue-connectivity.js` 단계 안에서 이미 실행됨) → `FE-BE-010`~`015`(Playwright `tests/fe-be-conditional.spec.ts`) → `AUTH-030`/`031`/`033`/`034`(k6 `api/scenarios/auth-lockout-ratelimit.js`) → `OPS-001`/`OPS-003`(`scripts/run-fault-injection.mjs`) → `OPS-002`(`scripts/verify-provider-malformed-response.mjs`) → `OPS-005`(`scripts/verify-partial-pod-failure.mjs`)까지 전부 돈다.
- `OPS-001`/`OPS-003`은 `DORO_ENVIRONMENT`가 `local`로 시작할 때만 실제로 실행된다 — 그 외의(실 배포) 대상에서는 `RUN_FAULT_INJECTION_TESTS` 설정과 무관하게 자동으로 SKIP된다. `scripts/run-fault-injection.mjs`가 로컬 Docker 주소·컨테이너 이름에 하드코딩돼 있어 실 배포를 대상으로 실행할 수 없기 때문에, 잘못된(로컬) 대상을 검증하고도 실 배포를 검증한 것처럼 보이는 상황을 막기 위한 안전장치다.
- 반대로 `OPS-002`/`OPS-005`는 `DORO_ENVIRONMENT`가 `local`로 시작하면 자동으로 SKIP된다 — 둘 다 `kubectl`로 실 EKS의 `store-access-api`를 직접 건드리는 실 배포 전용 스크립트라, 로컬 리허설 대상에서 실행할 이유가 없다(이 머신에 다른 실제 클러스터를 가리키는 `kubectl` 컨텍스트가 우연히 설정돼 있다면 로컬 리허설 도중 그 클러스터를 건드리는 일을 막기 위함).
- `RUN_DESTRUCTIVE_AUTH_TESTS=true`로 `run-full-gate.mjs`를 돌리면 `AUTH-030`~`034` 단계 직전에 **약 65초를 그대로 대기한다** — 바로 앞에서 `AUTH-015`가 `AUTH_LOCKOUT_01`의 Rate Limit Bucket을 소진시켜 놓고 가기 때문에, 대기 없이 곧바로 `AUTH-030`을 돌리면 5회 연속 `401`이어야 할 응답 중 일부가 `429`로 나와 실제 결함이 아닌 순서 문제로 FAIL이 날 수 있다.
- 두 스크립트 다 `DORO_RUN_ID`를 자동 생성하거나 이미 export돼 있으면 그대로 쓰고, 한 단계가 실패해도 나머지 단계는 계속 진행한 뒤 마지막에 종합 결과를 보여주고 실패가 하나라도 있으면 exit code 1로 끝난다. **`build-combined-summary.mjs` 단계의 exit code는 완화 판정(`frontBackConnected`)이 아니라 문서 §7 그대로의 엄격 판정(`passConnected`) 기준이다** — 둘이 갈리면 어느 §7 세부 조건이 걸렸는지 콘솔에 같이 출력된다.
- **파괴적 플래그는 오케스트레이터가 절대 자동으로 켜지 않는다** — `RUN_DESTRUCTIVE_AUTH_TESTS=true`(`AUTH-030`/`031`/`033`/`034`용), `RUN_DESTRUCTIVE_QUEUE_TESTS=true`(`QUEUE-003`용), `RUN_FAULT_INJECTION_TESTS=true`(`FE-BE-012` 및 `OPS-001`/`002`/`003`/`005`의 `--confirm` 대신 재사용됨)를 실행 전 직접 export해야만 해당 케이스가 실제로 돈다. 안 켜져 있으면 무엇을 export해야 하는지 안내 문구를 찍고 그 단계만 SKIP한다.

```bash
export DORO_FRONTEND_ORIGIN=https://doro.minseok.click
export DORO_API_ORIGIN=https://doro.minseok.click
export DORO_ENVIRONMENT=prod-alpha   # 실 배포 대상 이름 — 결과 리포트에 기록됨(미설정 시 "dev"로 잘못 기록됨)
export DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=...

# 종합 판정(passConnected)의 deploymentIdentityComplete 조건 때문에 이 단계가 필수다 — 반드시
# 위 값들을 export한 "뒤에", run-mandatory-gate.mjs를 실행하기 "전에" 아래 두 줄로 Revision 4개를
# 채운다(순서가 바뀌면 안 됨 — "Deployment Identity(Revision) 채우기" 절 참고).
AWS_PROFILE=erp-prod node scripts/resolve-deployment-identity.mjs
set -a; source .env.deployment-identity.local; set +a

node scripts/run-mandatory-gate.mjs
```

## 조건부/파괴적 항목을 구분한 이유

이 구분은 `Docs/Specifications/운영·배포/배포 Frontend–Backend 종단 검증.md` 문서 자체의 구조를 그대로 따른다 — §3 필수 Browser Gate + §5 공통 계약의 배포 재검증(대표 Slice) + §6의 비파괴 항목(`OPS-004`) + §10의 Tier A(`QUEUE-001`/`002`,`CATALOG-001`~`003`,`AUDIT-001`,`SALES-001`)만 "필수 게이트"(`run-mandatory-gate.mjs`)에 넣었다. 반대로 §4 조건부 Browser 시나리오, §5의 잠금/Rate Limit·Provider 오응답(`OPS-002`), §6의 Pod 장애 주입(`OPS-005`), §10의 Tier B(`QUEUE-003`,`CATALOG-004`~`006`)처럼 실제 서비스·계정·Pod·Service·테넌트 데이터에 실질적인 영향을 주는 항목은 "전체 게이트"(`run-full-gate.mjs`)로 분리해, 명시적 승인(플래그 또는 `--confirm`) 없이는 절대 자동으로 돌지 않도록 설계했다.

## 미구현 항목 설명

### A. 기존 항목과 겹쳐서 별도 구현하지 않음

- `AUTH-035`(보충 시간 후 재요청) — 별도 스크립트 없이도 `AUTH-031` 조사 과정에서 이미 관찰·문서화됨(위 "구현 범위 (현재)"의 실측 결과 주석 참고 — 계정 Bucket 리필과 잠금 만료 시점이 겹쳐서 `200`이 나오는 것을 확인한 부분).
- 재인증 UI 테스트, Provisioning API 외부 도달성 확인 — 검토 결과 불필요하다고 판단해 배제.

### B. 코드로 구현하기 어려운 상황 (설계/인프라 자체가 막힘)

- `OPS-003`(Redis 장애 실 배포 재현) — 실 배포의 Redis는 K8s Pod가 아니라 관리형 AWS ElastiCache라 `kubectl`로 건드릴 대상이 없다. NetworkPolicy 교체나 AWS 보안그룹 변경이 필요한데 둘 다 `doro-erp-e2e` 테스트 스크립트의 범위를 넘어서(`Doro-ERP-Infra`/`Doro-ERP-GitOps` 쪽 결정 필요) 보류 중이다.

### C. 실행 비용 때문에 제외

- `AUTH-032`(잠금 단계 1→2→4→8→15분 증가) — 기술적으로는 구현 가능하지만 실제 시계로 15분 이상 대기해야 해서 자동화 스위트에 넣지 않았다.

### D. 실행 자체의 위험 때문에 의도적으로 제외 (구현 난이도와 무관)

- `POST /api/v1/sales/daily/{date}/close`(영업일 마감) — `CATALOG-004`~`006`을 추가하며 함께 검토했으나, 되돌릴 Endpoint가 없는 회계·정산 확정 동작이라 반복 실행 시 그 영업일을 영구히 잠그는 실제 재무 리스크가 있다. `QUEUE-003`이 남기는 부작용(취소된 Entry 행, 대기 순번 소비)이나 `CATALOG-004`~`006`이 남기는 부작용(비활성화된 Category·Product)과 달리 "정상적으로 끝나면 무해"가 성립하지 않는 종류의 상태 변경이라, A/B/C 어디에도 넣지 않고 별도 항목으로 뺐다 — 구현이 어렵거나 시간이 걸려서가 아니라 실행 자체가 위험해서 자동화 스위트 대상에서 제외했다.

**참고**: `FE-BE-012`/`OPS-001`/`OPS-002`/`OPS-005`, 그리고 `AUTH-013`/`014`/`015`, `AUTH-030`/`031`,
`FE-BE-010`/`014`, `SESS-004`/`005`는 위 A/B/C와 다르다 — "미구현"이 아니라 코드는 이미 완성돼 있고,
전자 4개는 EKS 접근 권한이 없어서(위 "주의사항"의 EKS 접근 미검증 경고 참고), 후자 8개는
**실행 검증**만 못 한 상태다(정적 계정 8개 자체는 실 DB에 이미 생성돼 있는 것으로 확인됨 —
`Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md"` 참고, 이 실행 검증 미완료는 계정
미생성이 원인이 아니다).

### OPS-002 구현 메모

`OPS-002`(Provider 미승인 Cookie·Body → Edge `503` Fail-Closed)는 처음엔 `OPS-003`처럼 인프라 자체가 막혀서 보류했었다. `edge-api`의 `StoreAccessLoginForwarder.java`를 직접 확인해보니, 이 검증은 HMAC 서명이 아니라 순수 응답 모양(Body 3개 필드, Cookie 허용목록·속성) 검증이라 디코이가 진짜 서명 로직을 몰라도 된다는 걸 알게 됐고, 라우팅도 실 `store-access-api` Service의 `spec.selector`만 잠깐 디코이로 바꾸면 되는 걸 확인해서 `scripts/verify-provider-malformed-response.mjs`로 구현했다(위 "주의사항"의 영향 범위 경고 참고).

## Deployment Identity(Revision) 채우기

`deployment.{frontendRevision,cloudFrontDistributionId,edgeRevision,storeAccessRevision}`는 지금까지
전부 `"unknown"` placeholder였다 — 이 스크립트가 그 4개를 실제 값으로 채운다. **doro-erp-e2e 안의
코드만으로** 동작하도록 설계했다 — 다른 레포(Terraform output 추가, Frontend 빌드 관례 신설)를 고칠
필요가 없다:

| 필드 | 어떻게 얻나 |
|---|---|
| `cloudFrontDistributionId` | `aws cloudfront list-distributions` — Alias(도메인)로 찾음 |
| `frontendRevision` | 위에서 찾은 CloudFront Origin S3 버킷의 `index.html` **ETag**(`aws s3api head-object`) — Frontend가 git SHA를 심어야 하는 새 관례 불필요, 배포된 파일 내용이 바뀌면 자동으로 값도 바뀜 |
| `edgeRevision`/`storeAccessRevision` | `../Doro-ERP-GitOps/deploy/overlays/prod/alpha/kustomization.yaml`의 `images[]` 블록을 그대로 읽음(파일 읽기만, AWS 호출 없음) |

```bash
# AWS_PROFILE은 이미 구성돼 있어야 한다 — 이 스크립트는 자격증명을 저장·관리하지 않는다
# (Doro-ERP-Infra/bootstrap/README.md의 $env:AWS_PROFILE="erp-prod" 관례 그대로)
AWS_PROFILE=erp-prod node scripts/resolve-deployment-identity.mjs
# → .env.deployment-identity.local 생성. browser/api 실행 전에 같이 source한다:
set -a; source .env.deployment-identity.local; set +a
```

2026-08-25에 `team2` Profile(실제 프로젝트 계정 `727646470302`)로 실제 실행해 검증했다 — 그 과정에서
버그 하나를 잡았다: `Aliases.Quantity`가 0인 Distribution은 `Aliases.Items`가 빈 배열이 아니라 `null`이라
JMESPath `contains()`가 타입 오류를 냈다 — `Aliases.Items || \`[]\``로 null을 빈 배열로 바꿔 수정.
수정 후 결과: `cloudFrontDistributionId`는 실제 값(`E11TTHDEDC1G52`)을 정상적으로 가져왔고,
`frontendRevision`은 S3 `head-object`가 **`404 Not Found`**로 실패했다 — `index.html`이 버킷에 아예
없다는 뜻이다. `edgeRevision`/`storeAccessRevision`도 GitOps 파일에 `sha256:unconfigured`로 남아있어
`"unknown"`으로 떨어졌다. 셋 다 스크립트 버그가 아니라 **"이 환경은 아직 실제로 배포된 적이 없다"**는
지난번 CloudFront `enable_gateway_backend`·S3 `AccessDenied` 발견과 정확히 같은 결론을 서로 다른
경로(CloudFront 설정, GitOps 커밋, 이번엔 S3 객체 존재 여부)로 세 번째 확인해준 것이다.

## 환경변수 주입 (로컬)

값을 채우는 절차는 3단계다. (CI를 통한 주입은 아직 파이프라인 자체가 없어 별도로 정리하지 않는다.)

1. 팀에서 전달받은 실제 값을 준비한다(전달 경로는 기존 `AUTH_VALID_01`을 전달받았던 것과 동일한 Secret Store 경로 — 채팅/이슈에 평문으로 남기지 않는다).
2. 템플릿을 복사해 실제 값을 채운다: `cp .env.deploy-e2e.example .env.deploy-e2e.local` (`.local` 접미사가 `.gitignore`의 `.env.*.local` 패턴에 걸려 커밋되지 않는다).
3. 실행 직전에 shell로 로드한다: `set -a; source .env.deploy-e2e.local; set +a`

### 계정별 env var

| 별칭 | env var |
|---|---|
| `AUTH_VALID_01`(항상 필요) | `DORO_AUTH_VALID_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD` |
| `AUTH_LOCKOUT_01` | `DORO_AUTH_LOCKOUT_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD` |
| `AUTH_INACTIVE_EMPLOYEE_01` | `DORO_AUTH_INACTIVE_EMPLOYEE_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD` |
| `AUTH_INACTIVE_TENANT_01` | `DORO_AUTH_INACTIVE_TENANT_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD` |
| `AUTH_ROLE_OWNER_01` | `DORO_AUTH_ROLE_OWNER_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD` |
| `AUTH_ROLE_MANAGER_01` | `DORO_AUTH_ROLE_MANAGER_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD` |
| `AUTH_ROLE_STAFF_01` | `DORO_AUTH_ROLE_STAFF_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD` |
| `AUTH_TEMP_PASSWORD_01` | `DORO_AUTH_TEMP_PASSWORD_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD` |
| `AUTH_PASSWORD_ROTATE_01` | `DORO_AUTH_PASSWORD_ROTATE_01_TENANT_CODE` / `_LOGIN_ID` / `_PASSWORD_A` / `_PASSWORD_B`(예외적으로 4값) |

`AUTH_VALID_01` 외 8개는 없어도 실행 자체는 되며, 해당 계정을 쓰는 케이스만 `SKIP_PRECONDITION`으로
건너뛴다(폴백 없음) — 단 `FE-BE-014`는 `AUTH_ROLE_OWNER_01`/`MANAGER_01`/`STAFF_01` **3개가 전부**
있어야 실행된다(하나라도 없으면 스킵). 각 계정이 갖춰야 하는 정확한 상태(Role, 직원·테넌트·매장
상태, 비밀번호 상태)는 `Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md"` 참고.

### 계정 값과 별개로 필요한 플래그

계정 값이 다 채워져 있어도, 아래 두 플래그를 실행 전 직접 export하지 않으면 해당 플래그가 지키는
케이스는 여전히 SKIP된다(오케스트레이터가 대신 켜주지 않는다):

- `RUN_DESTRUCTIVE_AUTH_TESTS=true` — `AUTH-030`/`031`/`033`/`034`(`AUTH_LOCKOUT_01` 사용)
- `RUN_FAULT_INJECTION_TESTS=true` — `FE-BE-012`, `OPS-001`/`002`/`003`/`005`

## 실행 전제

- 로컬 실행 시 값을 채우는 방법은 바로 위 "환경변수 주입 (로컬)" 참고. 실제 값은 절대 커밋하지 않는다.
- ~~과거 결정: `AUTH_VALID_01` = `sample-store`/`owner` (정상 계정).~~
- 2026-08-26 결정: `AUTH_VALID_01`은 `AUTH_ROLE_OWNER_01`과 같은 `e2e-auth-active`/`e2e-role-owner`
  계정을 쓴다(부트캠프 규모라 별도 계정을 새로 요청하지 않음). 잠금·비활성·임시비밀번호 등 조건부
  Fixture는 준비되는 대로 추가.
- `FE-BE-003`/`SESS-001`이 공통으로 쓰는 비파괴 조회 API는 `GET /api/v1/orders`로 확정했다 — 로그인 성공 시 실제로 이동하는 `/pos/orders` 화면이 `onMounted`에서 자동 호출하고, Role 제한이 없다([PosOrdersView.vue](../Doro-ERP-Front/src/views/PosOrdersView.vue), [EdgeOrderController.java](../Doro-ERP-Service/apps/edge-api/src/main/java/com/dorosoft/erp/edge/presentation/EdgeOrderController.java)).
- 배포 전용 실행에서는 Mock, `page.route().fulfill()`, 인증 Session 사전 주입을 금지한다(배포 Frontend–Backend 종단 검증.md §2.1).
- 결과 로그는 `reports/<runId>/results.jsonl`(browser) 및 `reports/<runId>/<suite>.results.jsonl`(api, 같은 `reports/<runId>/` 폴더 아래 정리된다)을 정본으로 하며, Password·Cookie·Session·Token 원문은 절대 기록하지 않는다(배포 Frontend–Backend 종단 검증.md §2, §8). `build-combined-summary.mjs`가 같은 폴더에 만드는 `report.md`는 이 정본들을 `testCaseId` 순으로 재구성한 사람이 읽기 좋은 파생 산출물일 뿐, 그 자체가 정본은 아니다.
- **`AUTH_VALID_01` Rate Limit Bucket 주의**: `browser`와 `api` 스위트를 60초 이내에 이어서 돌리면 계정 Bucket(기본 용량 5)을 넘겨 뒤쪽 케이스가 잘못된 `429`로 실패할 수 있다. 자세한 내용과 대응은 [api/README.md](api/README.md#️-계정-rate-limit-bucket-주의) 참고.
- **Provisioning API는 어디서도 호출하지 않는다.** 실 테넌트 DB에 추적 안 되는 데이터가 생기는 걸 막기 위해 `AUTH-013`/`014`/`015`, `AUTH-030`/`031`, `FE-BE-010`/`014`, `SESS-004`/`005`의 Provisioning 폴백을 전부 삭제했다 — 정적 계정이 없으면 SKIP만 한다. (로컬 Docker Postgres에 계정을 만드는 `scripts/provision-local-rehearsal-account.mjs`는 별개다 — 실 테넌트 DB가 아니라 매번 새로 띄우는 격리된 로컬 컨테이너를 대상으로 하므로 이 금지와 무관하다.)

## 실행

아래는 각 단계를 손으로 직접 이어붙이는 수동 실행 방법이다 — 전체 스위트를 한 번에 돌릴 때는 위 "오케스트레이션 스크립트 사용법"의 `run-mandatory-gate.mjs`/`run-full-gate.mjs`를 쓰는 쪽을 권장한다. 아래 수동 흐름은 시나리오 파일 하나만 단독 실행하거나, 각 오케스트레이션 단계가 내부적으로 정확히 무엇을 하는지 파악하거나, 전체를 다시 돌리지 않고 특정 단계만 디버깅할 때 유용하다.

browser와 api 결과를 나중에 `build-combined-summary.mjs`로 묶으려면 **셋 다 같은 `DORO_RUN_ID`**를
지정해서 실행해야 한다(안 주면 각자 자동 생성한 다른 runId를 써서 서로 못 찾는다).

```bash
export DORO_RUN_ID=run-$(TZ='Asia/Seoul' date +%Y-%m-%d_%H-%M-%S)   # 세 실행이 전부 이 값을 쓴다

# 1) browser/ 와 api/ 에서 각각 실제 값을 채운 .env 를 준비한다 (또는 셸 export)
# 2) Playwright 배포 E2E
cd browser && npm install && npx playwright install chromium
DORO_FRONTEND_ORIGIN=... DORO_API_ORIGIN=... DORO_AUTH_VALID_01_TENANT_CODE=... \
DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... npx playwright test

# 3) k6 배포 API Runner (repo 루트에서 실행 — reports/ 위치 때문)
cd ..
DORO_API_ORIGIN=... DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... \
DORO_AUTH_VALID_01_PASSWORD=... k6 run --log-format=raw api/scenarios/auth-mandatory.js \
  > /tmp/k6-auth-mandatory.log 2>&1
node api/lib/build-report.mjs /tmp/k6-auth-mandatory.log AUTH-mandatory \
  AUTH-001,AUTH-002,AUTH-003,AUTH-004,AUTH-010,AUTH-020,AUTH-021,AUTH-022,AUTH-023,AUTH-024

# 4) k6 세션 흐름 — SESS-004/005까지 돌리려면 AUTH_TEMP_PASSWORD_01/AUTH_PASSWORD_ROTATE_01
# 정적 계정도 필요(없으면 그 둘만 SKIP, Provisioning 폴백 없음)
DORO_API_ORIGIN=... DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... \
DORO_AUTH_VALID_01_PASSWORD=... \
DORO_AUTH_TEMP_PASSWORD_01_TENANT_CODE=... DORO_AUTH_TEMP_PASSWORD_01_LOGIN_ID=... DORO_AUTH_TEMP_PASSWORD_01_PASSWORD=... \
DORO_AUTH_PASSWORD_ROTATE_01_TENANT_CODE=... DORO_AUTH_PASSWORD_ROTATE_01_LOGIN_ID=... \
DORO_AUTH_PASSWORD_ROTATE_01_PASSWORD_A=... DORO_AUTH_PASSWORD_ROTATE_01_PASSWORD_B=... \
  k6 run --log-format=raw api/scenarios/session-flow.js > /tmp/k6-session-flow.log 2>&1
node api/lib/build-report.mjs /tmp/k6-session-flow.log SESS SESS-001,SESS-002,SESS-003,SESS-006,SESS-007,SESS-004,SESS-005

# 5) 세 결과를 하나의 판정으로 묶는다
node scripts/build-combined-summary.mjs "$DORO_RUN_ID"
# → reports/<runId>/combined-summary.json(frontBackConnected 좁은 판정 포함) +
#   reports/<runId>/report.md(testCaseId 오름차순 사람이 읽기 좋은 요약, 정본은 아님)
```

`--log-format=raw`와 `build-report.mjs` 두 단계 다 필수다 — k6의 `handleSummary()`는 VU 실행과
별도의 격리된 JS VM에서 돌아서 실행 중 쌓은 결과를 볼 수 없다(로컬 리허설에서 실제로
`totalCases: 0`으로 재현·확인). 그래서 `api/lib/resultLogger.js`의 `record()`가 케이스마다
`console.log`로 한 줄씩 내보내는데, 이 줄은 stdout이 아니라 **stderr**로 나온다(k6 v2.2.0 실측
확인) — 위 명령들이 `2>&1`로 두 스트림을 합쳐서 파일로 받는 이유가 이것이다. `build-report.mjs`가
그 로그를 후처리해서 `reports/<runId>/<suite>.{results.jsonl,summary.json,junit.xml}`을 만든다 —
`api/README.md` 참고.

## 로컬 Docker Prod-like 리허설 모드

### 용어 정의 — "로컬 테스트"란

이 문서에서 "로컬 테스트"/"로컬 리허설"은 **정확히** 다음을 뜻한다: `Doro-ERP-Service/environments/local`의
Docker Compose로 6개 Spring Boot 서비스를 `prod` Profile + 자체 서명 TLS로 내 컴퓨터에 띄우고, 그걸 대상으로
`doro-erp-e2e`를 실행하는 것. 대상 Origin은 `https://localhost:8080`(Edge)이고, 계정은 `provision-local-rehearsal-account.mjs`가
그때그때 만든 1회용 테넌트다.

이건 실제 dev 배포(`doro.minseok.click`, CloudFront→ALB→EKS 실 인프라)를 대상으로 돌리는 것과 **다른 모드**다 —
후자는 `DORO_FRONTEND_ORIGIN`/`DORO_API_ORIGIN`을 `https://doro.minseok.click`으로 주고, AWS 자격증명으로
`scripts/resolve-deployment-identity.mjs`를 먼저 돌려 Revision 정보를 채운 뒤 실행한다. **로컬 리허설은 스크립트
자체 버그(셀렉터 깨짐·JSON 스키마 오타 등)를 미리 잡기 위한 것일 뿐, 배포 Frontend–Backend 종단 검증.md
§9의 "완료 조건"을 대체하지 않는다** — 아래 "이 모드가 증명하지 못하는 것"을 반드시 읽을 것.

**정적 계정 8개가 필요한 케이스(`AUTH-013`/`014`/`015`, `AUTH-030`/`031`, `FE-BE-010`/`014`, `SESS-004`/`005`)는
로컬 리허설로 검증할 수 없다.** 이 리포는 애초에 실 AWS 배포 검증이 본래 목적이고 로컬 리허설은 스크립트
버그를 미리 잡기 위한 부수적인 수단인데, 그 부수적인 용도를 위해 Provisioning API로 실 테넌트 DB에
계정을 만드는 경로를 남겨두지 않기로 했다(위 "실행 전제" 참고) — 정적 계정은 실 배포 대상 전용이라
로컬 Postgres엔 존재하지 않는다. 아래 명령들 중 이 8개 케이스에 해당하는 부분은 전부 `SKIP_PRECONDITION`으로만
끝난다.

### 사전 준비: `Doro-ERP-Service`의 기존 Prod-like Docker 스택

`ERP/Doro-ERP-Service/environments/local/`에 이미 구축돼 있다(`docker-compose.yml` + `docker-compose.apps.yml` +
`docker-compose.prod-like.yml` Overlay). 자세한 절차는 그 디렉터리의 `README.md`를 따르되, 요약하면:

```bash
cd ../Doro-ERP-Service
cp .env.example .env   # 로컬 전용 값으로 채운다 — 운영 Secret 아님
./gradlew bootJars
docker compose -f environments/local/docker-compose.yml up -d --wait
docker compose -f environments/local/docker-compose.apps.yml -f environments/local/docker-compose.prod-like.yml up -d --wait
```

이러면 6개 Spring Boot 서비스가 `prod` Profile + 자체 서명 TLS로 `https://localhost:8080`(edge)~`:8085`에 뜬다.

### Frontend: Vite dev 서버로 연결 (가벼운 방식 — Dockerfile 새로 안 만듦)

Vite dev 서버의 proxy(`/api` → Edge)가 자체 서명 인증서를 거부하는 문제가 있다. 두 가지를 시도해서 실측한 결과:

- **`NODE_EXTRA_CA_CERTS`로 `tls-init` 컨테이너 인증서를 신뢰 CA로 등록** — `docker cp`로 뽑은 인증서가
  컨테이너 실제 인증서와 바이트까지 동일함을 확인했는데도, `NODE_EXTRA_CA_CERTS`를 붙이면 여전히
  `self-signed certificate` 에러가 남는다(Windows/Git-Bash 환경에서 재현, 근본 원인 미해결 — 경로 표기
  문제로 의심했으나 Windows 경로로 바꿔도 동일). **이 방법은 이 환경에서 신뢰하지 말 것.**
- **`NODE_TLS_REJECT_UNAUTHORIZED=0`(Node 프로세스 전역)** — Vite 8의 proxy 엔진이 이 값을 안 봐서 역시
  실패한다(전역 TLS 검증 우회가 프록시 내부 HTTPS 클라이언트까지는 안 미침).

**실제로 동작을 확인한 유일한 방법은 `Doro-ERP-Front/vite.config.ts`의 proxy 옵션에 `secure: false`를
추가하는 것이다** — Vite proxy(`http-proxy`)가 자체 서명 대상을 위해 제공하는 전용 옵션이라 위 두 방법과
달리 실제로 먹힌다. 이건 **로컬 리허설 전용 임시 변경**이라 `Doro-ERP-Front`에 커밋하지 않는다 —
`doro-erp-e2e`는 이 폴더 밖 코드를 건드리지 않는다는 원칙(이 문서 상단 참고) 때문에, 리허설을 시작할 때
수동으로 추가했다가 끝나면 반드시 되돌린다.

```bash
cd ../Doro-ERP-Front

# vite.config.ts의 server.proxy['/api'] 블록에 아래 한 줄을 "임시로" 추가한다.
#   secure: edgeProxyTarget.startsWith('https://localhost') ? false : true,
# (자체 서명 대상일 때만 검증을 끄고, 실제 dev/stage/prod Origin에는 영향 없음)

VITE_EDGE_PROXY_TARGET=https://localhost:8080 npm run dev

# 리허설이 끝나면 반드시 원복한다 — 이 변경을 Doro-ERP-Front에 커밋하지 않는다.
git checkout -- vite.config.ts
```

### 계정 준비: `scripts/provision-local-rehearsal-account.mjs`

`Doro-ERP-Service`의 Flyway 마이그레이션에는 Seed 데이터가 없다(스키마만 생성) — `sample-store`/`owner`는
실제 dev 배포에만 존재하는 계정이고, 방금 띄운 로컬 Postgres에는 테넌트·매장·직원이 하나도 없다. 이 스크립트가
`ProvisioningController`(`POST /internal/v1/tenants`, `POST /internal/v1/tenants/{tenantId}/first-owner` —
`store-access-api` 8081에 직접, Edge를 거치지 않음)로 로컬 전용 테넌트+OWNER를 만들고, 임시 비밀번호로
로그인한 뒤 `PATCH /api/v1/employees/me/password`(Edge 8080)까지 호출해 **바로 로그인 가능한 영구 비밀번호
계정**으로 만들어 둔다. 같은 tenantCode/계정으로 몇 번을 다시 실행해도 안전하다(멱등) — 이미 끝난 상태면
아무것도 하지 않고 종료한다.

```bash
cd doro-erp-e2e
STORE_ACCESS_PROVISIONING_USERNAME=$(grep -m1 '^STORE_ACCESS_PROVISIONING_USERNAME=' ../Doro-ERP-Service/.env | cut -d= -f2-) \
STORE_ACCESS_PROVISIONING_PASSWORD=$(grep -m1 '^STORE_ACCESS_PROVISIONING_PASSWORD=' ../Doro-ERP-Service/.env | cut -d= -f2-) \
node scripts/provision-local-rehearsal-account.mjs
```

성공하면 `tenantCode`/`loginId`와 **비밀번호가 아닌** 저장 위치만 터미널에 출력하고, 실제 값은
`.env.local-rehearsal.local`(gitignore 대상, `.env.*.local` 패턴)에만 기록한다. 신규 생성·재실행(멱등)
둘 다 로컬 Docker Prod-like 스택에 직접 붙여 검증 완료.

**Rate Limit 토큰 비용**: 스크립트가 신규 계정을 만들 때 로그인 1회(임시 비밀번호 확인용)만 쓴다 —
영구 비밀번호 재검증 로그인은 토큰을 아끼려고 일부러 생략했다(처음엔 검증까지 3회를 써서 뒤에 돌리는
테스트 스위트가 곧바로 `429`를 맞는 걸 실제로 재현하고서 줄였다). 그래도 계정 Bucket 용량이 5뿐이라,
Provisioning 직후 곧바로 `FE-BE-002~006`(로그인 5회 필요) 풀 스위트를 돌리면 여전히 1개 모자라
마지막 케이스가 `429`로 막힐 수 있다 — **Provisioning 후 최소 60초 대기하거나(1개 보충), 스위트마다
별도 계정을 새로 만드는 쪽이 안전하다** (`.env.local-rehearsal.local`을 지우고 스크립트를 다시
실행하면 새 계정이 생긴다).

### `doro-erp-e2e` 실행

`DORO_ENVIRONMENT`가 `local`로 시작할 때만 `http://localhost`가 예외로 허용된다(그 외에는 배포
Frontend–Backend 종단 검증.md §2에 따라 여전히 HTTPS 강제, `browser/lib/env.ts`의 `requireOrigin` 참고). k6는 Vite를 거치지 않고 Edge
Container를 직접 때리므로 `DORO_API_ORIGIN`은 그대로 HTTPS이고, 자체 서명 인증서라
`--insecure-skip-tls-verify`가 추가로 필요하다(실제 dev/stage/prod에는 절대 쓰지 않음).

```bash
export DORO_RUN_ID=run-$(TZ='Asia/Seoul' date +%Y-%m-%d_%H-%M-%S)   # browser/api 세 실행 전부 이 값을 쓴다

# 위 스크립트가 만든 .env.local-rehearsal.local을 불러온다
set -a; source .env.local-rehearsal.local; set +a

# Playwright (repo 루트/browser 어디서든 무관 — reportPath가 파일 위치 기준이라 CWD 안 탐)
cd browser
DORO_FRONTEND_ORIGIN=http://localhost:5173 DORO_API_ORIGIN=http://localhost:5173 npx playwright test

# k6 (repo 루트에서) — --log-format=raw + build-report.mjs가 필요한 이유는 위 "실행" 절 참고
cd ..
DORO_API_ORIGIN=https://localhost:8080 \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/auth-mandatory.js \
  > /tmp/k6-auth-mandatory.log 2>&1
node api/lib/build-report.mjs /tmp/k6-auth-mandatory.log AUTH-mandatory \
  AUTH-001,AUTH-002,AUTH-003,AUTH-004,AUTH-010,AUTH-020,AUTH-021,AUTH-022,AUTH-023,AUTH-024

# SESS-004/005는 정적 계정(AUTH_TEMP_PASSWORD_01/AUTH_PASSWORD_ROTATE_01) 전용이라 로컬
# Postgres엔 그 계정이 없다 — 아래처럼 그냥 돌리면 두 케이스는 SKIP_PRECONDITION으로만 끝난다.
DORO_API_ORIGIN=https://localhost:8080 \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/session-flow.js \
  > /tmp/k6-session-flow.log 2>&1
node api/lib/build-report.mjs /tmp/k6-session-flow.log SESS SESS-001,SESS-002,SESS-003,SESS-006,SESS-007,SESS-004,SESS-005

# 세 결과를 하나로 묶는다
node scripts/build-combined-summary.mjs "$DORO_RUN_ID"
```

2026-08-24에 이 순서 그대로 로컬 Docker Prod-like 스택에 붙여 `FE-BE-001`~`006` 6/6, `AUTH-*` 10/10,
`SESS-001/002/004/005` 4/4, 그리고 셋을 묶은 `combined-summary.json`의 `frontBackConnected: true`까지
전부 확인했다(**단, 이건 Provisioning 폴백을 삭제하기 전 기록이다** — 이후 `AUTH-013`/`014`/`015`,
`SESS-004`/`005`가 전용 정적 계정 없이는 `SKIP_PRECONDITION`으로만 끝나도록 바뀌어서, 지금 같은
순서로 다시 돌리면 이 숫자가 그대로 재현되지 않는다. 위 "정적 계정 8개가 필요한 케이스" 참고). 이
과정에서 실제 버그 3개를 로컬 리허설로 잡았다:
- `FE-BE-006`의 `page.waitForURL('**/pos/login')`이 로그아웃 후 `goBack()`으로 돌아갈 때 실제 URL이
  `/pos/login?redirect=/pos/orders`(Router Guard가 Query String을 붙임)라 매칭에 실패해 Timeout까지
  걸렸다 — `**/pos/login**`로 수정.
- k6 `handleSummary()`가 VU 실행과 격리된 별도 VM에서 돌아 결과를 못 봄 — `console.log` + 후처리로 재설계.
- k6가 `reports/<runId>/` 같은 없는 하위 디렉터리에 자동으로 mkdir를 안 해줌 — 평평한 파일명으로 변경.

### 잠금·Rate Limit·장애 주입 (선택, 기본 비활성)

```bash
# AUTH-030/031/033/034 — 5회 실패 계정 잠금과 계정·IP Rate Limit Bucket 소진.
# AUTH-030/031은 AUTH_LOCKOUT_01 정적 계정이 로컬엔 없어서 SKIP_PRECONDITION으로 끝난다 —
# 033/034는 계정이 필요 없는 케이스라 그대로 돈다.
RUN_DESTRUCTIVE_AUTH_TESTS=true \
DORO_API_ORIGIN=https://localhost:8080 \
DORO_AUTH_VALID_01_TENANT_CODE=unused DORO_AUTH_VALID_01_LOGIN_ID=unused DORO_AUTH_VALID_01_PASSWORD=unused \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/auth-lockout-ratelimit.js \
  > /tmp/k6-lockout.log 2>&1
node api/lib/build-report.mjs /tmp/k6-lockout.log AUTH-lockout AUTH-030,AUTH-031,AUTH-033,AUTH-034

# OPS-001/003 — Store Access·Redis 컨테이너를 실제로 멈췄다 올린다 (--confirm 없이는 아무것도 안 함)
node scripts/run-fault-injection.mjs OPS-001 --confirm
node scripts/run-fault-injection.mjs OPS-003 --confirm
```

`AUTH_VALID_01` 값은 이 스크립트가 실제로 쓰지는 않지만 `loadDeployEnv()`가 공통으로 요구해서 더미 값을
넣어야 한다. 2026-08-24에 로컬 Docker Prod-like 스택에서 `AUTH-030/031/033/034` 4/4,
`OPS-001`/`OPS-003` 둘 다 PASS(장애 주입 → `503 LOGIN_UNAVAILABLE` → 컨테이너 재기동 → 정상 `401` 복구)까지
확인했다(**이것도 Provisioning 폴백을 삭제하기 전 기록이다** — 지금은 `AUTH-030`/`031`이
`AUTH_LOCKOUT_01` 정적 계정 없이는 `SKIP_PRECONDITION`으로만 끝난다). 가장 중요한 발견은 `AUTH-031`이다 — 계정 Rate Limit Bucket 용량(5)이 잠금 임계치(5회 실패)와
정확히 같아서, 5번째 실패 직후 요청은 **문서가 적은 `401`이 아니라 `429 AUTH_RATE_LIMITED`**로 막힌다
(정확한 비밀번호를 넣어도 마찬가지). Bucket이 먼저 소진되기 때문이며, 로컬 기본값(용량 5/분당 1)이
실제 운영 기본값과 같으므로 운영에서도 같은 현상이 예상된다. **실 배포 대상으로 돌릴 계획이라면
위 "주의사항"의 AUTH-034 공유 네트워크 경고를 반드시 먼저 읽을 것** — 로컬(자체 서명 인증서, 격리된
Docker 네트워크)에서는 안전하다.

### 이 모드가 증명하지 못하는 것

`Doro-ERP-Service/environments/local/README.md`가 스스로 명시한 한계를 그대로 물려받는다: 실제
IAM/Pod Identity, ALB·WAF, Security Group, Managed RDS·ElastiCache·SQS, 운영 인증서, CloudFront,
Auto Scaling·Backup·Failover는 전혀 검증하지 않는다. 여기서 전부 PASS해도 `summary.json`의
`environment`가 `local-prod-like`로 찍혀 있는 한, 배포 Frontend–Backend 종단 검증.md §9의 "완료 조건"·
`PASS_CONNECTED`와 같은 의미가 아니다 — 기존 `tests/system`/`AuthControllerIntegrationTest` 같은 "CODE_COMPLETE" 레벨
검증과 같은 급으로 취급한다.
