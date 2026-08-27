# doro-erp-e2e / api

k6 기반 배포 API Runner. `AUTH-*`, `SESS-*`, `QUEUE-*`, `CATALOG-*`, `AUDIT-*`, `SALES-*` 계약을 실제
배포 Origin에 직접 호출해 검증한다. 브라우저 Network 관찰이 필요한 `FE-BE-*`는 여기서 다루지 않는다 —
`../browser`(Playwright) 참고.

## 실행

저장소 루트(`doro-erp-e2e/`)에서 실행해야 `reports/`에 결과가 쌓인다. `--log-format=raw`로 실행하고
**stdout과 stderr를 함께(`2>&1`)** 파일로 받은 뒤 `api/lib/build-report.mjs`로 후처리해야 한다 —
`console.log()` 줄이 실제로는 stdout이 아니라 stderr로 나오기 때문이다(k6 v2.2.0 실측 확인). 이유는
"결과물" 절 참고.

```bash
export DORO_API_ORIGIN=https://doro.minseok.click
export DORO_AUTH_VALID_01_TENANT_CODE=sample-store
export DORO_AUTH_VALID_01_LOGIN_ID=owner
export DORO_AUTH_VALID_01_PASSWORD=***   # 로컬 Secret Store/CI Secret에서만 주입, 커밋 금지
export DORO_RUN_ID=run-$(TZ='Asia/Seoul' date +%Y-%m-%d_%H-%M-%S)   # 다른 스크립트/러너와 같은 runId를 쓰게 하려면 직접 고정

k6 run --log-format=raw api/scenarios/auth-mandatory.js > /tmp/auth-mandatory.log 2>&1
node api/lib/build-report.mjs /tmp/auth-mandatory.log AUTH-mandatory \
  AUTH-001,AUTH-002,AUTH-003,AUTH-004,AUTH-010,AUTH-020,AUTH-021,AUTH-022,AUTH-023,AUTH-024

# SESS-004/005까지 돌리려면 전용 정적 계정도 필요(없으면 그 둘만 SKIP_PRECONDITION, 나머지는 그대로 실행)
export DORO_AUTH_TEMP_PASSWORD_01_TENANT_CODE=... DORO_AUTH_TEMP_PASSWORD_01_LOGIN_ID=... DORO_AUTH_TEMP_PASSWORD_01_PASSWORD=...
export DORO_AUTH_PASSWORD_ROTATE_01_TENANT_CODE=... DORO_AUTH_PASSWORD_ROTATE_01_LOGIN_ID=...
export DORO_AUTH_PASSWORD_ROTATE_01_PASSWORD_A=... DORO_AUTH_PASSWORD_ROTATE_01_PASSWORD_B=...
k6 run --log-format=raw api/scenarios/session-flow.js > /tmp/session-flow.log 2>&1
node api/lib/build-report.mjs /tmp/session-flow.log SESS SESS-001,SESS-002,SESS-003,SESS-006,SESS-007,SESS-004,SESS-005
```

로컬 Docker Prod-like 리허설(자체 서명 TLS)을 대상으로 할 때만 `--insecure-skip-tls-verify`를 추가한다
— 실제 dev/stage/prod Origin에는 **절대 쓰지 않는다**(TLS 검증 자체를 끄는 옵션이라 진짜 배포 검증의
의미가 없어진다).

```bash
DORO_API_ORIGIN=https://localhost:8080 \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/auth-mandatory.js > /tmp/auth-mandatory.log 2>&1
```

## `AUTH-021`: 과대 로그인 Body의 안전한 거절

**실측으로 확인한 중요한 사실(`AUTH-021`, 운영 2026-08-27)**: `loginId`와 `password`에 각각
5,000자를 넣으면 JSON Body가 8KB를 넘어 CloudFront WAF의 `AWSManagedRulesCommonRuleSet`에 포함된
`SizeRestrictions_BODY`가 애플리케이션 도달 전에 HTTP `403`으로 차단한다. 반면 현재
`store-access-api`의 `LoginRequest`에는 `@NotBlank`만 있고 `@Size(max=...)`가 없어, 애플리케이션이
이 입력을 반드시 `400 VALIDATION_FAILED`로 거절한다는 기존 전제는 실제 계약과 맞지 않는다.

따라서 `AUTH-031`과 같은 원칙으로 정확한 상태 하나보다 “과대 입력을 안전하게 거절하고 내부 정보를
노출하지 않았는가”를 판정한다. 애플리케이션이 직접 `400 VALIDATION_FAILED`로 거절하거나 WAF가 먼저
`403`으로 거절하고 응답 Body에 예외·SQL·Java 내부 정보가 없으면 PASS다. 결과의
`observed.rejectionLayer`와 `errorClass`에는 각각 애플리케이션 Validation/WAF 거절을 구분해 기록한다.

## SESS-004 / SESS-005: 전용 정적 계정

`SESS-001`/`002`/`003`/`006`/`007`과 달리 `SESS-004`(임시 비밀번호 로그인)·`SESS-005`(비밀번호 변경
후 기존 Session 거절)는 `AUTH_VALID_01`을 재사용하지 않는다 — 이미 영구 비밀번호 상태라 "임시
비밀번호로 막 로그인한 계정"을 재현할 수 없기 때문이다. 실 테넌트 DB에 Provisioning API로 1회용
계정을 만드는 경로는 전면 삭제했다(실 테넌트 DB에 추적 안 되는 데이터가 생기는 걸 막기 위함) — 대신
미리 만들어둔 전용 정적 계정만 쓴다: `SESS-004`는 `AUTH_TEMP_PASSWORD_01`, `SESS-005`는
`AUTH_PASSWORD_ROTATE_01`(비밀번호 A/B 두 값 중 지금 어느 쪽이 현재 값인지 스스로 판별해 반대쪽으로
바꾼다). 정확한 계정 상태 요구사항은 `Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md"`
참고.

각 계정의 `DORO_<ALIAS>_TENANT_CODE`/`_LOGIN_ID`/`_PASSWORD`(rotate만 `_PASSWORD_A`/`_PASSWORD_B`)
중 하나라도 없으면 그 계정을 쓰는 케이스만 `SKIP_PRECONDITION`으로 건너뛰고 나머지는 그대로
실행된다 — 폴백 없음.

## `AUTH-030`/`031`/`033`/`034`: 잠금·Rate Limit (기본 비활성)

`api/scenarios/auth-lockout-ratelimit.js`는 `RUN_DESTRUCTIVE_AUTH_TESTS=true`를 명시적으로 줘야
실행된다(그 외엔 4개 케이스 전부 `SKIP_PRECONDITION`) — 배포 Frontend–Backend 종단 검증.md §2가 요구하는
"잠금·Rate Limit은 전용 Fixture와 격리 Source가 있을 때만 실행" 안전장치 그대로다.

```bash
RUN_DESTRUCTIVE_AUTH_TESTS=true \
DORO_API_ORIGIN=https://doro.minseok.click \
DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... \
DORO_AUTH_LOCKOUT_01_TENANT_CODE=... DORO_AUTH_LOCKOUT_01_LOGIN_ID=... DORO_AUTH_LOCKOUT_01_PASSWORD=... \
  k6 run --log-format=raw api/scenarios/auth-lockout-ratelimit.js > /tmp/lockout.log 2>&1
node api/lib/build-report.mjs /tmp/lockout.log AUTH-lockout AUTH-030,AUTH-031,AUTH-033,AUTH-034
```

- `AUTH-030`/`031`(5회 실패 계정 잠금)은 전용 정적 계정 `AUTH_LOCKOUT_01`을 쓴다(멱등 — 이미
  잠겨 있어도 안전) — 없으면 이 둘만 `SKIP_PRECONDITION`.
- `AUTH-033`(존재하지 않는 loginId로 계정 Bucket 소진)·`AUTH-034`(격리 IP에서 IP Bucket 소진)는
  실재하지 않는 가짜 tenantCode/loginId만 쓰므로 정적 계정이 없어도 실행된다.
- `AUTH-032`(잠금 1→2→4→8→15분 단계 증가)는 실제 clock으로 15분 이상 기다려야 해서 아직 넣지 않았다.
- `AUTH-035`(충분한 보충 시간 후 재요청)는 시간 비용 때문이 아니라, 바로 위 `AUTH-031` 조사 과정에서
  사실상 이미 관찰돼(계정 Bucket 리필과 잠금 만료 시점이 겹쳐 `200`이 나오는 것을 확인) 별도로
  구현하지 않았다.

**⚠️ `AUTH-034`는 실 배포(dev/stage/prod) 대상으로 절대 공유 네트워크에서 실행하지 말 것.** Client IP
Rate Limit Bucket을 의도적으로 소진시키는 케이스라, 사무실 Wi-Fi·공유 VPN·공유 NAT처럼 다른 사람과
같은 공인 IP를 쓰는 환경에서 돌리면 **그 IP를 쓰는 다른 실제 사용자의 로그인까지 같이 429로 막힐 수
있다**(배포 문서 §5 "격리 Source"가 요구하는 게 바로 이것). 로컬 리허설(자체 서명 인증서, 격리된
Docker 네트워크)에서는 이 문제가 없어 안전하게 실행해도 된다. 실 배포 대상으로 돌리려면 다른 실사용자
트래픽과 절대 안 겹치는 전용 IP(별도 CI Runner, 전용 VPN Exit 등)를 먼저 확보해야 한다 — 이건
`doro-erp-e2e` 코드로 해결할 수 없는 인프라/네트워크 준비 사항이다. `AUTH-030`/`031`/`033`은 계정
단위 Bucket이라 이 문제가 없다.

**실측으로 확인한 중요한 사실(`AUTH-031`)**: 계정 Rate Limit Bucket 용량(5)이 잠금 임계치(5회 실패)와
정확히 같다. 그래서 "잠금 직후" 6번째 요청은 정확한 비밀번호를 넣어도 문서가 적은 `401`이 아니라
**`429 AUTH_RATE_LIMITED`**로 막힌다 — Bucket이 5번째 실패 시점에 이미 0으로 소진돼 있기 때문이다.
로컬 기본값(용량 5/분당 1)이 운영 기본값과 같으므로(`STORE_ACCESS_IDENTITY_RATE_LIMIT_ACCOUNT_CAPACITY`
기본값) 운영에서도 같은 현상이 예상된다. 두 응답 모두 "요청을 안전하게 거절하고 잠금 상세를 노출하지
않는다"는 실제 의도는 만족하므로, `AUTH-031`의 판정 기준은 정확히 `401`이 아니라
"`200`이 아니고, 안전한 Problem 응답(`code` 존재)이고, 내부 정보가 없는지"로 잡았다.

## `AUTH-011`~`015`: 계정 존재 비노출

`api/scenarios/auth-account-nonexposure.js`. 다섯 시나리오 전부 같은 `401 AUTHENTICATION_FAILED` +
같은 Problem 스키마로 응답해야 한다 — 공격자가 응답만 보고 "loginId가 없다"/"테넌트가 없다"/
"계정이 비활성이다"/"잠겨 있다"를 구분할 수 없어야 한다는 게 이 그룹의 요점이다.

```bash
DORO_API_ORIGIN=https://doro.minseok.click \
DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... \
DORO_AUTH_INACTIVE_EMPLOYEE_01_TENANT_CODE=... DORO_AUTH_INACTIVE_EMPLOYEE_01_LOGIN_ID=... DORO_AUTH_INACTIVE_EMPLOYEE_01_PASSWORD=... \
DORO_AUTH_INACTIVE_TENANT_01_TENANT_CODE=... DORO_AUTH_INACTIVE_TENANT_01_LOGIN_ID=... DORO_AUTH_INACTIVE_TENANT_01_PASSWORD=... \
DORO_AUTH_LOCKOUT_01_TENANT_CODE=... DORO_AUTH_LOCKOUT_01_LOGIN_ID=... DORO_AUTH_LOCKOUT_01_PASSWORD=... \
RUN_DESTRUCTIVE_AUTH_TESTS=true \
  k6 run --log-format=raw api/scenarios/auth-account-nonexposure.js > /tmp/nonexposure.log 2>&1
node api/lib/build-report.mjs /tmp/nonexposure.log AUTH-nonexposure AUTH-011,AUTH-012,AUTH-013,AUTH-014,AUTH-015
```

케이스별 전제조건이 다르다:

| ID | 필요한 것 |
|---|---|
| `AUTH-011`/`012` | 없음 — 실재하지 않는 가짜 tenantCode/loginId만 씀(정적 계정 불필요) |
| `AUTH-013`(INACTIVE 직원) | 전용 정적 계정 `AUTH_INACTIVE_EMPLOYEE_01`만 있으면 됨 — `RUN_DESTRUCTIVE_AUTH_TESTS`는 요구하지 않음 |
| `AUTH-014`(INACTIVE 테넌트) | 전용 정적 계정 `AUTH_INACTIVE_TENANT_01`만 있으면 됨 — 마찬가지로 `RUN_DESTRUCTIVE_AUTH_TESTS` 불필요 |
| `AUTH-015`(잠금 상태) | 전용 정적 계정 `AUTH_LOCKOUT_01` **+** `RUN_DESTRUCTIVE_AUTH_TESTS=true` — `auth-lockout-ratelimit.js`와 같은 이유로 계정을 실제로 잠그기 때문. `run-mandatory-gate.mjs`는 이 플래그를 절대 켜지 않으므로 그 안에서는 항상 `SKIP_PRECONDITION`이고, 필수 통과 판정에도 포함하지 않는다(`run-full-gate.mjs`에서만 `RUN_DESTRUCTIVE_AUTH_TESTS=true`로 실행) |

구현 중 실제로 잡은 버그 3개:

1. **`PasswordPolicyValidator`가 비밀번호에 `loginId`를 부분 문자열로 포함하면 거부한다.**
   `loginId="owner"`인 계정에 비밀번호 접두어로 `"Owner013"`을 썼다가 `400 WEAK_PASSWORD`를
   실제로 봤다 — `loginId`와 겹치지 않는 접두어(`"Fixture013"` 등)로 바꿔서 해결.
2. **`EmployeeController`의 직원 생성/상태 변경(`POST /employees`, `PATCH /{id}/status` 등)은
   행위자 본인이 이미 비밀번호를 바꿨을 것을 요구한다.** OWNER가 임시 비밀번호 상태로 바로
   `createEmployee`를 부르면 `403 PASSWORD_CHANGE_REQUIRED` — 직원 생성 전에 OWNER 본인의
   비밀번호부터 완료해야 한다.
3. **비밀번호 변경은 성공하는 순간 그 계정의 기존 Session을 전부 무효화한다**(`SESS-005`가
   검증하는 것과 같은 동작). 변경 직후 방금 쓴 Session으로 `createEmployee`를 불렀다가
   `401 UNAUTHENTICATED`("직원 세션을 확인할 수 없습니다")를 봤다 — 새 비밀번호로 재로그인해서
   새 Session을 받은 뒤에 이어가야 한다.

그리고 `AUTH-015`는 처음에 `AUTH-031`과 똑같은 실수를 반복했다 — 5회 실패 직후 65초를 기다렸더니
계정 Rate Limit Bucket 리필과 잠금 만료가 거의 같은 주기(둘 다 ~60초)라 거의 동시에 풀려서
`200`(로그인 성공)이 나왔다. 기다리지 않고 5번째 실패 직후 바로 확인하도록 고쳐서,
`AUTH-031`과 같은 판정 기준(`401` 또는 `429` 둘 다 "안전한 거절"로 인정, `200`이면 실패)을 적용했다.

## `QUEUE-001`~`003`: `queue-api` 연결성·업무 로직 (Tier A/B)

`api/scenarios/queue-connectivity.js`. `AUTH_VALID_01`(OWNER) 하나만으로 실행된다 —
`EntryQueueService.requireEmployee()`/`FulfillmentQueueService`가 요구하는 Role은 OWNER/MANAGER/STAFF
전부라 OWNER 계정으로 충분하다(전용 정적 계정 불필요).

```bash
DORO_API_ORIGIN=https://doro.minseok.click \
DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... \
  k6 run --log-format=raw api/scenarios/queue-connectivity.js > /tmp/queue-connectivity.log 2>&1
node api/lib/build-report.mjs /tmp/queue-connectivity.log QUEUE QUEUE-001,QUEUE-002

# QUEUE-003(상태 변경)까지 실행하려면 플래그를 추가로 켠다
RUN_DESTRUCTIVE_QUEUE_TESTS=true DORO_API_ORIGIN=... DORO_AUTH_VALID_01_TENANT_CODE=... \
DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... \
  k6 run --log-format=raw api/scenarios/queue-connectivity.js > /tmp/queue-connectivity.log 2>&1
node api/lib/build-report.mjs /tmp/queue-connectivity.log QUEUE QUEUE-001,QUEUE-002,QUEUE-003
```

- `QUEUE-001`(`GET /api/v1/queues/fulfillment`)·`QUEUE-002`(`GET /api/v1/queues/entry?businessDate=<오늘>`)는
  전제조건 없이 항상 실행된다 — 목록이 비어 있어도 `200`이다(`FulfillmentQueueController`/`EntryQueueController`
  둘 다 존재 검사 없는 단순 SELECT).
- `<오늘>`(영업일)은 `AUTH_VALID_01` 소속 매장이 `Asia/Seoul`이라는 전제 아래 UTC+9 고정 오프셋으로
  계산한다(`queue-connectivity.js`의 `todayBusinessDate()`) — 매장은 원칙상 임의의 IANA Time Zone을
  가질 수 있지만(`Docs/Specifications/01 업체·매장 관리/ADR.md`), 이 전제는 배포 Frontend–Backend
  종단 검증.md §10에 명시돼 있다. `AUTH_VALID_01`의 소속 매장 시간대가 바뀌면 이 계산도 함께 갱신해야 한다.
- `QUEUE-003`(Entry 등록 → `WAITING` 확인 → 취소 → `CANCELLED` 확인 → 재취소)은
  `RUN_DESTRUCTIVE_QUEUE_TESTS=true`가 있어야 실행된다 — 취소된 Entry 행과 그 Store·영업일 대기
  순번 소비를 실 테넌트 데이터에 영구히 남기기 때문이다(배포 Frontend–Backend 종단 검증.md §10 참고).
  `AUTH-030`~`034`가 쓰는 `RUN_DESTRUCTIVE_AUTH_TESTS`는 인증 도메인 전용 위험(계정 잠금·Rate Limit)을
  이름에 명시한 플래그라 재사용하지 않고 별도 플래그를 뒀다.
- `Idempotency-Key`는 k6 goja 런타임에 `crypto.randomUUID()`가 없어 `api/lib/provisioning.js`의
  `randomUuidV4()`(`Math.random()`만으로 RFC 4122 버전/변형 비트를 채우는 최소 구현)로 매 실행마다
  새로 만든다.
- 목록 조회 단언이 실패해도 등록된 Entry가 `WAITING`으로 방치되지 않도록, 등록에 성공했다면 취소는
  `try`/`finally`로 항상 시도한다(`scripts/verify-partial-pod-failure.mjs`의 "항상 정리 시도" 철학과 동일).
  재취소는 `QueueErrorCode.STATE_CONFLICT`(`409`)로 거절돼야 한다(`QueueErrorCode.java` 확인 완료).

## `CATALOG-001`~`006`: `commerce-api` Catalog 연결성 (Tier A)·업무 로직 (Tier B)

`api/scenarios/catalog-connectivity.js`. `CATALOG-001`~`003`(Tier A)은 `AUTH_VALID_01`(OWNER)의
`SESSION` Cookie만 있으면 되는 비파괴 조회이며 전제조건 없이 항상 실행된다.

```bash
DORO_API_ORIGIN=https://doro.minseok.click \
DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... \
  k6 run --log-format=raw api/scenarios/catalog-connectivity.js > /tmp/catalog-connectivity.log 2>&1
node api/lib/build-report.mjs /tmp/catalog-connectivity.log CATALOG CATALOG-001,CATALOG-002,CATALOG-003

# CATALOG-004~006(Category·Product 생성·수정·품절 전환)까지 실행하려면 플래그와 AUTH_ROLE_OWNER_01을 추가로 준다
RUN_DESTRUCTIVE_CATALOG_TESTS=true DORO_API_ORIGIN=... \
DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... \
DORO_AUTH_ROLE_OWNER_01_TENANT_CODE=... DORO_AUTH_ROLE_OWNER_01_LOGIN_ID=... DORO_AUTH_ROLE_OWNER_01_PASSWORD=... \
  k6 run --log-format=raw api/scenarios/catalog-connectivity.js > /tmp/catalog-connectivity.log 2>&1
node api/lib/build-report.mjs /tmp/catalog-connectivity.log CATALOG \
  CATALOG-001,CATALOG-002,CATALOG-003,CATALOG-004,CATALOG-005,CATALOG-006
```

- `CATALOG-001`(`GET /api/v1/catalog/menu`)은 `EdgeCatalogController`가 `SESSION` Cookie XOR Kiosk
  Cookie만 확인한다 — 이 러너는 SESSION만 보내므로 `AMBIGUOUS_AUTHENTICATION`과 무관하다.
- `CATALOG-002`(`categories`)/`CATALOG-003`(`products`)은 `CommerceManagementRouteController` →
  `CatalogService.requireCatalogOperator()`를 거치며, `ActorRole.canChangeSoldOut()`이 OWNER/MANAGER/STAFF
  전부에 대해 `true`라 OWNER로 충분하다(Category·Product 관리 자체를 바꾸는 `canManageCatalog()`은
  OWNER/MANAGER만 필요하지만 조회는 더 넓게 허용됨 — `ActorRole.java` 확인 완료).
- Category/Product가 하나도 없는 테넌트라도 `loadManagedCategories()`/`loadManagedProducts()`는 평범한
  Repository 조회라 빈 배열과 함께 `200`을 반환한다(`CatalogService.java` 확인 완료).

### `CATALOG-004`~`006`: Category·Product 생성·수정·품절 전환 (Tier B, 기본 비활성)

`RUN_DESTRUCTIVE_CATALOG_TESTS=true`가 있어야 실행된다(그 외엔 세 케이스 전부
`SKIP_PRECONDITION`) — `QUEUE-003`과 같은 이유로 실제로 상태를 바꾸기 때문이다. `CATALOG-001`~`003`과
달리 `AUTH_VALID_01`이 아니라 `AUTH_ROLE_OWNER_01`로 별도 로그인한다(파일 안에서 두 번째 로그인 호출) —
`AUTH_VALID_01`의 테넌트(`sample-store`)는 실 데모 테넌트라 영구 Catalog 데이터를 남기고 싶지 않고,
`AUTH_ROLE_OWNER_01`의 테넌트(`e2e-auth-active`)는 실 고객이 0명인 합성 E2E 전용 테넌트라 영구히
남아도 안전하기 때문이다(DB 직접 조회로 확인 완료). `AUTH_ROLE_OWNER_01`이 env에 없으면
`auth-lockout-ratelimit.js`의 `if (!env.staticAccounts.lockout)`과 같은 패턴으로 세 케이스 모두
`SKIP_PRECONDITION`.

- `CATALOG-004`(Category 생성 → 목록 확인 → `PATCH`+`If-Match` 수정 → 확인 → 비활성화)와
  `CATALOG-005`(전용 Category 생성 → 그 아래 Product 생성 → 목록 확인 → 수정 → 확인 → 상품·Category
  비활성화)는 서로 다른 전용 Category를 각자 새로 만든다 — 하나가 실패해도 다른 하나의 원인 분리가
  쉽도록 의도적으로 독립시켰다(CATALOG-005가 CATALOG-004의 Category를 재사용하지 않음).
- `CATALOG-006`(품절 `true`→확인→`false`→확인)은 `CATALOG-005`가 만든 Product를 그대로 이어받는다 —
  같은 k6 iteration 안에서 그룹이 순서대로(동기) 실행되므로 `CATALOG-005`가 실패해 Product를 못
  만들었으면 `CATALOG-006`도 `SKIP_PRECONDITION`이다. 이 케이스는 셋 중 유일하게 **완전히 가역적**이다
  (일반적인 Audit 기록 외에는 실 테넌트에 영구 흔적을 남기지 않는다) — 그래도 독립적으로 실행할 방법이
  없어(대상 Product가 있어야 하므로) 같은 플래그로 묶었다.
- `DELETE` Endpoint가 없어 생성한 Category·Product는 영구히 남는다 — 그래서 실행마다 겹치지 않는
  이름(`E2E-CATALOG-*-${randomUuidV4().slice(0,8)}`)으로 만들고, 결과와 무관하게 `finally`에서
  `active:false` 비활성화를 반드시 시도한다(`QUEUE-003`의 "항상 정리 시도" 철학과 동일).
- `PATCH` 계약은 `CatalogService.updateCategory()`/`updateProduct()`를 직접 확인한 결과 **부분
  업데이트**다 — Body의 각 필드가 `null`이면 그 필드는 바꾸지 않는다. 그래서 비활성화 호출은
  `{active:false}`만 보내도 안전하다.
- Create/Update 응답은 `ETag` Header(`"<version>"`)뿐 아니라 JSON Body 자체에도 `version` 필드를
  그대로 담고 있다(`CategoryView`/`ProductView`가 Java record라 Body 그대로 직렬화됨 — 확인 완료).
- `POST /api/v1/sales/daily/{date}/close`(영업일 마감)는 이 러너의 대상이 아니다 — 되돌릴 Endpoint가
  없는 회계 확정 동작이라 반복 실행 시 영업일을 영구히 잠그는 실제 위험이 있어, 구현 난이도가 아니라
  실행 자체의 위험 때문에 의도적으로 제외했다(아래 "미구현 항목"의 A/B/C 분류와는 다른 사유 —
  배포 Frontend–Backend 종단 검증.md §10 참고).

## `AUDIT-001`, `SALES-001`: `audit-api`·`commerce-api` sales 도메인 연결성 (Tier A)

`api/scenarios/audit-sales-connectivity.js`. 둘 다 `AUTH_VALID_01` 하나만으로 실행되는 비파괴
조회이며, 이 파일 안에서 로그인을 1회만 공유한다 — 왜 두 케이스를 별도 파일로 나누지 않고 여기
합쳤는지는 아래 "⚠️ 계정 Rate Limit Bucket 주의"와 파일 상단 주석 참고.

```bash
DORO_API_ORIGIN=https://doro.minseok.click \
DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... \
  k6 run --log-format=raw api/scenarios/audit-sales-connectivity.js > /tmp/audit-sales-connectivity.log 2>&1
node api/lib/build-report.mjs /tmp/audit-sales-connectivity.log AUDIT-SALES AUDIT-001,SALES-001
```

- `AUDIT-001`(`GET /api/v1/audits`)은 `EdgeAuditController.java`(edge-api)가 `from`/`to`를 optional
  String으로 그대로 audit-api에 전달하지만, 실제 필수 검증은 `AuditQueryService.validate()`
  (audit-api)가 담당한다 — 없으면 `400`(`AuditQueryService.java` 확인 완료). `AuditQueryController.java`
  의 `parseInstant()`가 `Instant.parse()`로 파싱하므로 ISO-8601 Instant 포맷(`Date.toISOString()`이
  그대로 맞는 포맷)이어야 하고, 이 러너는 최근 1시간 범위로 조회한다.
- `AUDIT-001`의 Role은 `AuditQueryService.authorizedActor()`가 `actorType=="EMPLOYEE" &&
  (role=="OWNER" || role=="MANAGER")`만 통과시킨다 — `STAFF`는 `AUDIT_ROLE_NOT_ALLOWED`(`403`)로
  거절된다(`AuditQueryExceptionAdvice.java`/`AuditQueryProblemCode.java` 확인 완료). `AUTH_VALID_01`
  이 실제로 이 조건을 만족하는지는 로그인 응답 Body(`LoginResponse{employeeId,role,
  passwordChangeRequired}` — `StoreAccessLoginForwarder.java`가 그대로 relay, 확인 완료)의 `role`
  필드를 이 러너가 직접 읽어서 `observed.accountRole`에 남긴다 — status만으로 판정하면 역할
  불일치로 인한 `403`과 다른 원인의 `403`을 구분할 수 없기 때문이다.
- `AUDIT-001`의 성공 조건은 `AuditQueryPage{items,nextCursor}`가 그대로 직렬화되므로, 레코드가
  없어도 `{items:[],nextCursor:null}`과 함께 `200`이다(`AuditQueryPage.java` 확인 완료).
- `SALES-001`(`GET /api/v1/sales/daily?businessDate=<오늘>`)은 공개 `SalesController`가 아니라 HMAC
  전용 `EdgeSalesManagementController.java`(commerce-api, `/internal/v1/edge/sales/daily`)로
  라우팅된다 — Edge 쪽은 `CommerceManagementRouteController.java`의 GET 매핑이 세션 쿠키를 확인한
  뒤 `CommerceManagementRouteForwarder`로 그 내부 경로에 전달한다(GET이라 CSRF 검사도 건너뜀 —
  XSRF-TOKEN 대조는 `method!=GET`일 때만, 확인 완료).
- `SALES-001`의 `<오늘>`(영업일) 계산은 `queue-connectivity.js`의 `STORE_UTC_OFFSET_MINUTES=9*60`
  고정 오프셋 로직을 그대로 재사용한다(같은 코드를 복사 — `AUTH_VALID_01` 소속 매장이 `Asia/Seoul`
  이라는 같은 전제).
- `SALES-001`의 Role은 `SalesService.employee()`가 `actor.canReadSales()`만 확인하고,
  `ActorContext.canReadSales()`는 `actorType==EMPLOYEE`만 보고 `OWNER`/`MANAGER`/`STAFF`를 구분하지
  않는다(`ActorContext.java` 확인 완료) — `AUDIT-001`과 달리 Role 제한이 없다.
- `SALES-001`은 "오픈 상태" 플래그가 아니라 `SalesService.requireCurrentBusinessDate()`가 매 요청마다
  `store-access-api`의 `BusinessDateCalculator.currentBusinessDate()`(서버 현재 Instant를 매장
  시간대로 변환한 `LocalDate`)와 비교해서 정확히 일치해야만 통과시킨다(`SalesService.java` 확인
  완료) — 다르면 `409`(`CONFLICT`)다. Runner의 로컬 계산과 서버의 계산 시점이 KST 자정을 사이에 두고
  갈라지면 실제 결함이 아닌 `409`가 날 수 있어, KST 자정 전후 5분 이내에 실행되면 이 케이스는
  실패로 기록하지 않고 `SKIP_PRECONDITION`(사유: "자정 경계 근처 실행 회피")으로 건너뛴다.
- `SALES-001`의 성공 조건은 마감(Daily Closing) 레코드가 없어도 실시간 집계로 `200`이다
  (`SalesService.daily()` 확인 완료 — closing 레코드 존재를 요구하지 않음).

## `OPS-001`/`OPS-003`: 장애 주입 (기본 비활성, 로컬 전용)

`scripts/run-fault-injection.mjs`는 k6가 아니라 별도 Node 스크립트다 — Docker 컨테이너를 직접
멈췄다 올려야 해서 k6 JS 샌드박스로는 할 수 없는 일이다(Store Access·Redis 컨테이너 이름이
하드코딩돼 있어 로컬 Docker Prod-like 스택 전용이며 실제 dev/stage/prod에는 쓸 수 없다).

```bash
node scripts/run-fault-injection.mjs OPS-001 --confirm   # Store Access 정지 → 503 → 재기동 → 401 복구
node scripts/run-fault-injection.mjs OPS-003 --confirm   # Redis 정지 → 503 → 재기동 → 401 복구
```

`--confirm` 없이 실행하면 아무 컨테이너도 건드리지 않고 사용법만 출력하고 끝난다(배포 Frontend–Backend
종단 검증.md §6의 "장애 주입은 전용 Stage 또는 승인된 점검 시간에 운영 담당자가 수행" 안전장치를 로컬
스크립트 차원에서 흉내낸 것). 컨테이너를 멈춘 뒤에는 무슨 일이
있어도(예외 발생 포함) `finally`에서 다시 올리는 것을 보장한다. 결과는 `reports/<runId>/ops-00N.results.jsonl`에
쌓인다(`build-report.mjs`를 거치지 않고 스크립트가 직접 씀 — 케이스가 하나뿐이라 후처리가 필요 없다).

2026-08-24에 로컬 Docker Prod-like 스택에서 둘 다 실행해 확인: 컨테이너 정지 → `503 LOGIN_UNAVAILABLE`
(내부 정보 비노출) → 컨테이너 재기동 → Health `UP` → 로그인 요청 다시 `401`(정상 처리 재개)까지 PASS.

## ⚠️ 계정 Rate Limit Bucket 주의

`AUTH_VALID_01`(`sample-store`/`owner`) 계정의 서버측 Rate Limit Bucket은 **기본 용량 5회, 분당 1회 보충**이다.
이 저장소의 스크립트들은 실계정 로그인 호출 수를 아래처럼 최소화해뒀다.

| 스크립트 | `AUTH_VALID_01` 로그인 호출 수 |
|---|---|
| `auth-mandatory.js` | 4회 (`AUTH-001`+`AUTH-002`+`AUTH-024` 병합 1회, `AUTH-003` 1회, `AUTH-004` 1회, `AUTH-010` 1회) |
| `session-flow.js` | 3회 (`SESS-001`/`002`/`003`/`006` 공용 최초 로그인 1회 + `SESS-007` 내부의 사전 로그인·재로그인 2회) — `SESS-004`/`005`는 별도 정적 계정(`AUTH_TEMP_PASSWORD_01`/`AUTH_PASSWORD_ROTATE_01`)을 써서 이 Bucket을 건드리지 않는다 |
| `queue-connectivity.js` | 1회 (`QUEUE-001`/`002` 공용 로그인) — `QUEUE-003`도 같은 로그인을 재사용해 추가 호출 없음 |
| `catalog-connectivity.js` | 1회 (`CATALOG-001`~`003` 공용 로그인) — `CATALOG-004`~`006`은 `AUTH_VALID_01`이 아니라 `AUTH_ROLE_OWNER_01`로 별도 로그인해 이 Bucket을 전혀 건드리지 않는다(아래 참고) |
| `audit-sales-connectivity.js` | 1회 (`AUDIT-001`/`SALES-001` 공용 로그인) — 별도 프로세스라 Cookie Jar를 이어받지 못해 새 로그인이 필요하다(파일 상단 주석 참고) |
| **`../browser` (Playwright) FE-BE-002~006** | 성공 로그인 여러 회 + 실패 로그인 1회 |

**`AUTH_ROLE_OWNER_01`은 `AUTH_VALID_01`과 별개의 계정 단위 Rate Limit Bucket을 쓴다** — 서버측
Bucket이 `(tenantCode, loginId)` 단위로 격리돼 있어(`AUTH-030`~`034`가 검증하는 것과 같은 계정
단위 Bucket 구조), `CATALOG-004`~`006`이 `RUN_DESTRUCTIVE_CATALOG_TESTS=true`로 추가 로그인 1회를
써도 위 표의 `AUTH_VALID_01` 소진 계산(3+1+1=5)에는 전혀 영향을 주지 않는다. 확인 결과 non-issue이며,
`run-mandatory-gate.mjs`/`run-full-gate.mjs`의 기존 대기 로직을 바꿀 필요가 없다.

**용량 5·분당 1회 보충인데 위 스크립트들을 합치면 한 번에 5를 훌쩍 넘는다 — 대기 없이 이어서
돌리면 뒤에 실행되는 케이스가 실제 결함이 아닌 `429 AUTH_RATE_LIMITED`로 잘못 실패한다.** 이 문제는
저장소 루트의 `scripts/run-mandatory-gate.mjs`(오케스트레이터)가 단계 사이에 Bucket이 완전히
다시 찰 만큼(용량 5 ÷ 분당 1 리필 = 5분) 자동으로 대기해서 처리한다 — `session-flow.js`(3회) 직후에는
`queue-connectivity.js`(1회) → `catalog-connectivity.js`(1회)를 추가 대기 없이 바로 이어붙이는데,
그 앞의 5분 대기로 Bucket이 5로 꽉 찬 상태에서 3+1+1=5로 정확히 맞춰뒀기 때문이다(그 사이에
`AUTH_VALID_01` 로그인을 더 쓰는 단계를 끼워 넣으면 이 계산이 깨진다). `catalog-connectivity.js`
뒤에는 `audit-sales-connectivity.js`(1회)를 이어붙이는데, 이 시점엔 이미 Bucket을 5까지 다 썼으므로
그 사이에 다시 5분을 대기해 Bucket을 5로 채운 뒤 1만 쓰는 것으로 예산 계산이 리셋된다(그 뒤에 또
`AUTH_VALID_01` 로그인 단계를 추가하려면 이 표와 `run-mandatory-gate.mjs`의 주석을 함께 갱신할 것).
아래 예시처럼 손으로 직접 이어붙여 실행할 때만 다음 중 하나로 직접 대응해야 한다.

- `auth-mandatory.js` → `session-flow.js` → `queue-connectivity.js` → `catalog-connectivity.js` →
  (5분 대기) → `audit-sales-connectivity.js` → `browser` 순서로 실행하되, 괄호로 표시한 구간만
  최소 5분 이상 간격을 두고 나머지는 위 설명대로 대기 없이 이어붙여도 정확히 용량 안에서 끝난다.
- 반복 실행이 잦다면 dev 환경에서 `sample-store`/`owner` 전용으로 Rate Limit 용량을 늘리는 걸
  인프라팀에 요청한다(운영 계정에는 적용하지 않는다).
- Client IP Bucket(기본 용량 30, 분당 6 보충)은 이 정도 호출량으로는 넉넉하므로 별도 조치 불필요.

## 결과물

k6의 `handleSummary()`는 **VU가 테스트를 실행하는 것과 완전히 격리된 별도 JS VM 인스턴스**에서 돈다
— 그래서 `record()`가 모듈 스코프에 쌓은 결과를 `handleSummary()` 쪽에서는 항상 빈 배열로 본다
(로컬 리허설에서 `totalCases: 0`으로 실제 재현·확인, `lib/resultLogger.js` 주석 참고). 이 경계를 우회할
core k6 API가 없어서, `record()`는 케이스마다 `console.log(JSON.stringify(entry))`로 즉시 한 줄씩
내보내고, `k6 run --log-format=raw`로 그 줄들이 k6 자체 로그 접두어 없이 그대로 찍히게 한다.
**이 줄은 stdout이 아니라 stderr로 나온다**(k6 v2.2.0 실측 확인) — 위 "실행" 절의 수동 명령이
`2>&1`로 두 스트림을 합쳐서 파일로 받는 이유가 이것이다. 저장소 루트의 오케스트레이터
(`scripts/run-mandatory-gate.mjs` 등)는 이 스트림 문제를 피하려고 `--console-output=<파일>`로
k6가 그 줄들을 직접 파일에 쓰게 한다. 어느 경로든 `api/lib/build-report.mjs`(평범한 Node
스크립트)가 그 파일을 후처리해서 `reports/<runId>/<suite>.{results.jsonl,summary.json,junit.xml}`을
만든다 — browser가 쓰는 `reports/<runId>/results.jsonl`과 같은 `reports/<runId>/` 폴더 아래다.

k6 코어 JS 자체에는 mkdir API가 없어서, 없는 하위 디렉터리를 `--console-output`이나 handleSummary
반환값으로 직접 가리키면 조용히 쓰기 실패만 한다(로컬 리허설에서 실제 재현·확인) — 그래서 이
저장소는 k6를 실행하기 전에 Node(`scripts/lib/gate-steps.mjs`의 `runK6Scenario()`)가 먼저
`reports/<runId>/` 디렉터리를 `mkdirSync`로 만들어 둔다. `build-report.mjs`도 파일을 쓰기 전에
같은 디렉터리를 한 번 더 만들어서(`fs`가 있어 문제없다), 이 스크립트 하나만 단독 실행할 때도
안전하다.

browser(Playwright) 결과와 합쳐 하나의 판정(`frontBackConnected`)을 보려면 저장소 루트의
`scripts/build-combined-summary.mjs <runId>`를 쓴다 — browser/api 실행에 같은 `DORO_RUN_ID`를
지정해야 서로 짝지어진다. 이 스크립트는 `combined-summary.json`과 함께 `reports/<runId>/report.md`도
만든다 — 모든 케이스를 `testCaseId` 오름차순으로 정리한 사람이 읽기 좋은 Markdown 표로, 정본은
여전히 `combined-summary.json`/각 스위트의 `results.jsonl`이다.

## 알려진 한계

- k6 응답 Cookie 객체(`res.cookies`)는 `secure`/`http_only`는 노출하지만 `SameSite`는 노출하지 않는다.
  `lib/http.js`의 `cookieAttrs()`가 원본 `Set-Cookie` 헤더 문자열에서 정규식으로 최선의 노력으로
  추출하며, 못 찾으면 `null`을 반환한다. 결과 JSONL의 `assertions.sameSiteCheckable`이 `false`면
  이 실행에서는 SameSite를 확인하지 못했다는 뜻이다.
- 세분화된 5단계 종료 코드(0/1/2/3/4)는 아직 없다. 지금은 k6 자체의 `checks` 임계치
  (`rate==1`)와 `build-report.mjs`의 exit code(실패 케이스가 있으면 1)로 하나라도 실패하면 비정상
  종료하는 수준만 구현돼 있다. `resultCode`별 세분화된 종료 코드가 필요하면 후속 작업이 남아 있다.
- `AUTH-032`(잠금 단계 1→2→4→8→15분 증가)는 기술적으로는 구현 가능하지만 실제 시계로 15분 이상
  대기해야 해서 자동화 스위트에 넣지 않았다.
- `AUTH-035`(보충 시간 후 재요청)는 시간 비용 때문이 아니라, `AUTH-031` 조사 과정에서 사실상 이미
  관찰돼 별도 구현 없이 문서화만 했다(`api/scenarios/auth-lockout-ratelimit.js`의 "실측 결과" 주석
  참고 — 계정 Bucket 리필과 잠금 만료 시점이 겹쳐서 `200`이 나오는 것을 확인한 부분. README.md
  "미구현 항목 설명"과 같은 분류).
- `OPS-002`/`004`/`005`는 "미구현"이 아니다 — 코드는 이미 완성돼 있고(`scripts/verify-provider-malformed-response.mjs`/`verify-edge-boundary.mjs`/`verify-partial-pod-failure.mjs`),
  `OPS-004`만 2026-08-25에 실 AWS 배포로 PASS까지 확인했다. `OPS-002`/`005`는 이 작업 환경에 EKS
  접근 권한이 없어 **실행 검증**만 못 한 상태다(README.md "주의사항"의 EKS 접근 미검증 경고 참고).
- `SALES-001`은 KST 자정 전후 5분 이내에 실행되면 `SKIP_PRECONDITION`이 된다(위 "`AUDIT-001`,
  `SALES-001`" 절 참고). `run-mandatory-gate.mjs`는 이 타이밍 의존성 때문에 `SALES-001`을
  `mandatoryApiCasesPassed` 계산에서 뺐다(`AUTH-015`를 뺀 것과 같은 이유) — 이 케이스 자체는 그대로
  실행·기록되지만, 이 좁은 시간대에 게이트를 돌렸다는 이유만으로 종합 판정이 실패하지는 않는다.
  `AUDIT-001`은 이런 타이밍 의존성이 없어 그대로 필수 판정에 포함된다.
