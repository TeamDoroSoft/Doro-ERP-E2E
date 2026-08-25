# doro-erp-e2e / api

k6 기반 배포 API Runner. `AUTH-*`, `SESS-*` 계약을 실제 배포 Origin에 직접 호출해 검증한다.
브라우저 Network 관찰이 필요한 `FE-BE-*`는 여기서 다루지 않는다 — `../browser`(Playwright) 참고.

## 실행

저장소 루트(`doro-erp-e2e/`)에서 실행해야 `reports/`에 결과가 쌓인다. `--log-format=raw`로 실행해
stdout을 파일로 받은 뒤 `api/lib/build-report.mjs`로 후처리해야 한다 — 이유는 "결과물" 절 참고.

```bash
export DORO_API_ORIGIN=https://doro.minseok.click
export DORO_AUTH_VALID_01_TENANT_CODE=sample-store
export DORO_AUTH_VALID_01_LOGIN_ID=owner
export DORO_AUTH_VALID_01_PASSWORD=***   # 로컬 Secret Store/CI Secret에서만 주입, 커밋 금지
export DORO_RUN_ID=run-$(date +%Y%m%d-%H%M%S)   # 다른 스크립트/러너와 같은 runId를 쓰게 하려면 직접 고정

k6 run --log-format=raw api/scenarios/auth-mandatory.js > /tmp/auth-mandatory.log 2>&1
node api/lib/build-report.mjs /tmp/auth-mandatory.log auth-mandatory \
  AUTH-001,AUTH-002,AUTH-003,AUTH-004,AUTH-010,AUTH-020,AUTH-021,AUTH-022,AUTH-023,AUTH-024

# SESS-004/005까지 돌리려면 Provisioning 자격증명도 필요(없으면 그 둘만 SKIP_PRECONDITION)
export PROVISIONING_ORIGIN=https://internal-store-access-origin   # store-access-api에 직접, Edge 아님
export STORE_ACCESS_PROVISIONING_USERNAME=***
export STORE_ACCESS_PROVISIONING_PASSWORD=***
k6 run --log-format=raw api/scenarios/session-flow.js > /tmp/session-flow.log 2>&1
node api/lib/build-report.mjs /tmp/session-flow.log session-flow SESS-001,SESS-002,SESS-004,SESS-005
```

로컬 Docker Prod-like 리허설(자체 서명 TLS)을 대상으로 할 때만 `--insecure-skip-tls-verify`를 추가한다
— 실제 dev/stage/prod Origin에는 **절대 쓰지 않는다**(TLS 검증 자체를 끄는 옵션이라 진짜 배포 검증의
의미가 없어진다).

```bash
DORO_API_ORIGIN=https://localhost:8080 \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/auth-mandatory.js > /tmp/auth-mandatory.log 2>&1
```

## SESS-004 / SESS-005: 1회용 Fixture

`SESS-001`/`002`와 달리 `SESS-004`(임시 비밀번호 로그인)·`SESS-005`(비밀번호 변경 후 기존 Session
거절)는 `AUTH_VALID_01`을 재사용하지 않는다 — 이미 영구 비밀번호 상태라 "임시 비밀번호로 막 로그인한
계정"을 재현할 수 없기 때문이다. 대신 `api/lib/provisioning.js`가 이 두 케이스 전용 1회용 테넌트+OWNER를
`PROVISIONING_ORIGIN`(`store-access-api`에 직접, Edge 아님)에 만들어서 쓰고 끝난 뒤 버린다.

`PROVISIONING_ORIGIN`/`STORE_ACCESS_PROVISIONING_USERNAME`/`STORE_ACCESS_PROVISIONING_PASSWORD` 중
하나라도 없으면 `SESS-004`/`005`만 `SKIP_PRECONDITION`으로 건너뛰고 `SESS-001`/`002`는 그대로 실행된다
— 실제 dev/stage AWS를 대상으로 할 때, Provisioning 자격증명을 일부러 안 넘겨서 테스트가 그 환경에
알아서 테넌트를 만들지 않게 하는 것도 유효한 선택이다.

## `AUTH-030`/`031`/`033`/`034`: 잠금·Rate Limit (기본 비활성)

`api/scenarios/auth-lockout-ratelimit.js`는 `RUN_DESTRUCTIVE_AUTH_TESTS=true`를 명시적으로 줘야
실행된다(그 외엔 4개 케이스 전부 `SKIP_PRECONDITION`) — 배포 Frontend–Backend 종단 검증.md §2가 요구하는
"잠금·Rate Limit은 전용 Fixture와 격리 Source가 있을 때만 실행" 안전장치 그대로다.

```bash
RUN_DESTRUCTIVE_AUTH_TESTS=true \
DORO_API_ORIGIN=https://doro.minseok.click \
DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=... \
PROVISIONING_ORIGIN=... STORE_ACCESS_PROVISIONING_USERNAME=... STORE_ACCESS_PROVISIONING_PASSWORD=... \
  k6 run --log-format=raw api/scenarios/auth-lockout-ratelimit.js > /tmp/lockout.log 2>&1
node api/lib/build-report.mjs /tmp/lockout.log auth-lockout-ratelimit AUTH-030,AUTH-031,AUTH-033,AUTH-034
```

- `AUTH-030`/`031`(5회 실패 계정 잠금)도 `SESS-004`/`005`처럼 이 케이스 전용 1회용 계정을 새로
  만들어 쓴다 — Provisioning 자격증명이 없으면 이 둘만 `SKIP_PRECONDITION`.
- `AUTH-033`(존재하지 않는 loginId로 계정 Bucket 소진)·`AUTH-034`(격리 IP에서 IP Bucket 소진)는
  실재하지 않는 가짜 tenantCode/loginId만 쓰므로 Provisioning 자격증명이 없어도 실행된다.
- `AUTH-032`(잠금 1→2→4→8→15분 단계 증가)와 `AUTH-035`(충분한 보충 시간 후 재요청)는 실제 clock으로
  몇 분을 기다려야 해서 아직 넣지 않았다.

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
PROVISIONING_ORIGIN=... STORE_ACCESS_PROVISIONING_USERNAME=... STORE_ACCESS_PROVISIONING_PASSWORD=... \
RUN_DESTRUCTIVE_AUTH_TESTS=true \
  k6 run --log-format=raw api/scenarios/auth-account-nonexposure.js > /tmp/nonexposure.log 2>&1
node api/lib/build-report.mjs /tmp/nonexposure.log auth-account-nonexposure AUTH-011,AUTH-012,AUTH-013,AUTH-014,AUTH-015
```

케이스별 전제조건이 다르다:

| ID | 필요한 것 |
|---|---|
| `AUTH-011`/`012` | 없음 — 실재하지 않는 가짜 tenantCode/loginId만 씀(`AUTH_VALID_01`도 Provisioning도 불필요) |
| `AUTH-013`(INACTIVE 직원)/`014`(INACTIVE 테넌트) | Provisioning 자격증명만 있으면 됨 — `SESS-004/005`와 같은 급의 위험도(1회용 Fixture 조작)라 `RUN_DESTRUCTIVE_AUTH_TESTS`는 요구하지 않음 |
| `AUTH-015`(잠금 상태) | Provisioning 자격증명 **+** `RUN_DESTRUCTIVE_AUTH_TESTS=true` — `auth-lockout-ratelimit.js`와 같은 이유로 계정을 실제로 잠그기 때문 |

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
있어도(예외 발생 포함) `finally`에서 다시 올리는 것을 보장한다. 결과는 `reports/<runId>.ops-00N.results.jsonl`에
쌓인다(`build-report.mjs`를 거치지 않고 스크립트가 직접 씀 — 케이스가 하나뿐이라 후처리가 필요 없다).

2026-08-24에 로컬 Docker Prod-like 스택에서 둘 다 실행해 확인: 컨테이너 정지 → `503 LOGIN_UNAVAILABLE`
(내부 정보 비노출) → 컨테이너 재기동 → Health `UP` → 로그인 요청 다시 `401`(정상 처리 재개)까지 PASS.

## ⚠️ 계정 Rate Limit Bucket 주의

`AUTH_VALID_01`(`sample-store`/`owner`) 계정의 서버측 Rate Limit Bucket은 **기본 용량 5회, 분당 1회 보충**이다.
이 저장소의 스크립트들은 실계정 로그인 호출 수를 아래처럼 최소화해뒀다.

| 스크립트 | `AUTH_VALID_01` 로그인 호출 수 |
|---|---|
| `auth-mandatory.js` | 4회 (`AUTH-001`+`AUTH-002`+`AUTH-024` 병합 1회, `AUTH-003` 1회, `AUTH-004` 1회, `AUTH-010` 1회) |
| `session-flow.js` | 1회 (`SESS-001`/`002`) — `SESS-004`/`005`는 1회용 Fixture를 따로 써서 이 Bucket을 건드리지 않는다 |
| **`../browser` (Playwright) FE-BE-002~006** | 5회 (성공 로그인 4회 + 실패 로그인 1회) |

**전체를 60초 안에 이어서 돌리면 합계가 5를 넘어 뒤에 실행되는 케이스가 `429 AUTH_RATE_LIMITED`로
잘못 실패할 수 있다.** 다음 중 하나로 대응한다.

- `auth-mandatory.js` → `session-flow.js` → `browser` 순서로 실행하되 각 사이 최소 60초 이상 간격을 둔다.
- 반복 실행이 잦다면 dev 환경에서 `sample-store`/`owner` 전용으로 Rate Limit 용량을 늘리는 걸
  인프라팀에 요청한다(운영 계정에는 적용하지 않는다).
- Client IP Bucket(기본 용량 30, 분당 6 보충)은 이 정도 호출량으로는 넉넉하므로 별도 조치 불필요.

## 결과물

k6의 `handleSummary()`는 **VU가 테스트를 실행하는 것과 완전히 격리된 별도 JS VM 인스턴스**에서 돈다
— 그래서 `record()`가 모듈 스코프에 쌓은 결과를 `handleSummary()` 쪽에서는 항상 빈 배열로 본다
(로컬 리허설에서 `totalCases: 0`으로 실제 재현·확인, `lib/resultLogger.js` 주석 참고). 이 경계를 우회할
core k6 API가 없어서, `record()`는 케이스마다 `console.log(JSON.stringify(entry))`로 즉시 한 줄씩
stdout에 내보내고, `k6 run --log-format=raw`로 그 줄들이 k6 자체 로그 접두어 없이 그대로 찍히게 한 뒤,
`api/lib/build-report.mjs`(평범한 Node 스크립트)가 그 stdout을 후처리해서
`reports/<runId>.<suite>.{results.jsonl,summary.json,junit.xml}`을 만든다.

같은 이유로 파일명은 `reports/<runId>/results.jsonl`처럼 하위 디렉터리를 쓰지 않고
`reports/<runId>.<suite>.results.jsonl`처럼 `reports/` 바로 아래 평평하다 — k6 코어 JS에는 mkdir
API가 없어서 없는 하위 디렉터리를 handleSummary 반환값으로 가리키면 조용히 쓰기 실패만 하기 때문이다
(이것도 로컬 리허설에서 실제 재현·확인). Node 쪽(`build-report.mjs`)은 `fs`가 있어 문제없다.

browser(Playwright) 결과와 합쳐 하나의 판정(`frontBackConnected`)을 보려면 저장소 루트의
`scripts/build-combined-summary.mjs <runId>`를 쓴다 — browser/api 실행에 같은 `DORO_RUN_ID`를
지정해야 서로 짝지어진다.

## 알려진 한계

- k6 응답 Cookie 객체(`res.cookies`)는 `secure`/`http_only`는 노출하지만 `SameSite`는 노출하지 않는다.
  `lib/http.js`의 `cookieAttrs()`가 원본 `Set-Cookie` 헤더 문자열에서 정규식으로 최선의 노력으로
  추출하며, 못 찾으면 `null`을 반환한다. 결과 JSONL의 `assertions.sameSiteCheckable`이 `false`면
  이 실행에서는 SameSite를 확인하지 못했다는 뜻이다.
- 세분화된 5단계 종료 코드(0/1/2/3/4)는 아직 없다. 지금은 k6 자체의 `checks` 임계치
  (`rate==1`)와 `build-report.mjs`의 exit code(실패 케이스가 있으면 1)로 하나라도 실패하면 비정상
  종료하는 수준만 구현돼 있다. `resultCode`별 세분화된 종료 코드가 필요하면 후속 작업이 남아 있다.
- `AUTH-032`(잠금 단계 증가)·`AUTH-035`(보충 시간 후 재요청)는 실제 clock 대기 비용이 커서,
  `OPS-002`(배포 Frontend–Backend 종단 검증.md §5)·`OPS-004`/`005`(같은 문서 §6)는 WAF·ALB·Pod 단위
  실제 인프라가 전제라 로컬로 의미 있게 재현이 안 돼서 아직 구현하지 않았다.
