# doro-erp-e2e

`배포 Frontend–Backend 종단 검증`
(`ERP/Docs/Specifications/운영·배포/배포 Frontend–Backend 종단 검증.md`)을 구현하는 배포 종단(End-to-End) 테스트 러너.

`Doro-ERP-Front`, `Doro-ERP-Infra`, `Doro-ERP-Service`, `Docs`, `Doro-ERP-GitOps`와 마찬가지로 독립 git 저장소이며,
`Final_Project/CLAUDE.md`의 브랜치 네이밍(`feature/`, `bugfix/`, `refactor/`, `hotfix/`)과 리뷰 워크플로우(Claude 구현 → Codex 로컬 diff 리뷰)를 동일하게 따른다.

## 빠른 시작

필요한 값을 이미 갖고 있고 지금 바로 필수 게이트를 돌려보고 싶다면:

```bash
export DORO_FRONTEND_ORIGIN=https://doro.minseok.click
export DORO_API_ORIGIN=https://doro.minseok.click
export DORO_ENVIRONMENT=prod-alpha
export DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... DORO_AUTH_VALID_01_PASSWORD=...

node scripts/run-mandatory-gate.mjs
```

Deployment Identity(Revision) 채우기 등 엄격 판정(`passConnected`)에 필요한 사전 단계는 생략했다 — 전체 조건은 아래 "실행" 절 참고.

## 문서 구성

이 저장소에는 문서 3개가 있다:

- `README.md`(이 문서) — 개요, 준비, 실행 방법
- `LOCAL_REHEARSAL.md` — 로컬 Docker Prod-like 리허설 모드 상세
- `api/README.md` — k6 러너 세부 사항(Rate Limit, 케이스별 전제조건 등)

## 목차

- [빠른 시작](#빠른-시작)
- [문서 구성](#문서-구성)
- [구조](#구조)
- [준비](#준비)
  - [환경변수 주입 (로컬)](#환경변수-주입-로컬)
  - [Deployment Identity(Revision) 채우기](#deployment-identityrevision-채우기)
  - [실행 전제](#실행-전제)
- [실행](#실행)
  - [오케스트레이션 스크립트 사용법](#오케스트레이션-스크립트-사용법)
  - [손으로 직접 실행 (수동)](#손으로-직접-실행-수동)
- [로컬 Docker Prod-like 리허설 모드](#로컬-docker-prod-like-리허설-모드)
- [참고 자료](#참고-자료)
  - [구현 범위 (현재)](#구현-범위-현재)
  - [주의사항](#주의사항)
  - [조건부/파괴적 항목을 구분한 이유](#조건부파괴적-항목을-구분한-이유)
  - [미구현 항목 설명](#미구현-항목-설명)

## 구조

```
doro-erp-e2e/
├── browser/            # Playwright 배포 E2E — FE-BE-* (실제 배포 화면, Network 관찰 포함)
│   ├── tests/
│   └── lib/
├── api/                # k6 배포 API Runner — AUTH-*, SESS-*, OPS-*
│   ├── scenarios/
│   └── lib/
├── shared/             # 두 러너가 공유하는 결과 스키마/판정 규칙 정의 (이 저장소 자체가 정본)
├── reports/            # 실행 산출물 (runId별, gitignore 대상)
├── .env.deploy-e2e.example   # 환경변수 템플릿 (플레이스홀더만, 실값 커밋 금지)
```

`browser`(Playwright)와 `api`(k6)를 같은 저장소 안에 두되 도구는 분리한다 — k6 Browser 모듈은 `page.on('request')`/`page.route()`/CDP 접근을 지원하지 않아
`FE-BE-002`~`006`이 요구하는 Network 계층 관찰(배포 Frontend–Backend 종단 검증.md §3)을 충족할 수 없기 때문 ([grafana/k6#4020](https://github.com/grafana/k6/issues/4020)). 자세한 도구 선정 근거는 같은 문서 §2.1 참고.

## 준비

실 배포 대상으로 실행하기 전에 필요한 값 주입·계정 상태 확인 절차다.

### 환경변수 주입 (로컬)

값을 채우는 절차는 3단계다. (CI를 통한 주입은 아직 파이프라인 자체가 없어 별도로 정리하지 않는다.)

1. 팀에서 전달받은 실제 값을 준비한다(전달 경로는 기존 `AUTH_VALID_01`을 전달받았던 것과 동일한 Secret Store 경로 — 채팅/이슈에 평문으로 남기지 않는다).
2. 템플릿을 복사해 실제 값을 채운다: `cp .env.deploy-e2e.example .env.deploy-e2e.local` (`.local` 접미사가 `.gitignore`의 `.env.*.local` 패턴에 걸려 커밋되지 않는다).
3. 실행 직전에 shell로 로드한다: `set -a; source .env.deploy-e2e.local; set +a`

#### 계정별 env var

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

#### 계정 값과 별개로 필요한 플래그

계정 값이 다 채워져 있어도, 아래 두 플래그를 실행 전 직접 export하지 않으면 해당 플래그가 지키는
케이스는 여전히 SKIP된다(오케스트레이터가 대신 켜주지 않는다):

- `RUN_DESTRUCTIVE_AUTH_TESTS=true` — `AUTH-030`/`031`/`033`/`034`(`AUTH_LOCKOUT_01` 사용)
- `RUN_FAULT_INJECTION_TESTS=true` — `FE-BE-012`, `OPS-001`/`002`/`003`/`005`

### Deployment Identity(Revision) 채우기

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

**현재 상태(2026-08-25 `team2` Profile 기준)**: `cloudFrontDistributionId`만 정상적으로 채워지고
(`E11TTHDEDC1G52`), `frontendRevision`(S3에 `index.html` 없음)과 `edgeRevision`/`storeAccessRevision`
(GitOps에 `sha256:unconfigured`)은 `"unknown"`으로 나온다 — 스크립트 결함이 아니라 **이 환경에 아직
실 배포가 없기 때문**이다. 실 배포가 완료되면 재확인이 필요하다.

### 실행 전제

- 로컬 실행 시 값을 채우는 방법은 바로 위 "환경변수 주입 (로컬)" 참고. 실제 값은 절대 커밋하지 않는다.
- `AUTH_VALID_01` = `sample-store`/`owner` (정상 계정). 잠금·비활성·임시비밀번호 등 조건부 Fixture는 준비되는 대로 추가.
- `FE-BE-003`/`SESS-001`이 공통으로 쓰는 비파괴 조회 API는 `GET /api/v1/orders`로 확정했다 — 로그인 성공 시 실제로 이동하는 `/pos/orders` 화면이 `onMounted`에서 자동 호출하고, Role 제한이 없다([PosOrdersView.vue](../Doro-ERP-Front/src/views/PosOrdersView.vue), [EdgeOrderController.java](../Doro-ERP-Service/apps/edge-api/src/main/java/com/dorosoft/erp/edge/presentation/EdgeOrderController.java)).
- 배포 전용 실행에서는 Mock, `page.route().fulfill()`, 인증 Session 사전 주입을 금지한다(배포 Frontend–Backend 종단 검증.md §2.1).
- 결과 로그는 `reports/<runId>/results.jsonl`(browser) 및 `reports/<runId>.<suite>.results.jsonl`(api, k6는 하위 디렉터리를 자동 생성 못 해서 평평한 파일명을 씀)을 정본으로 하며, Password·Cookie·Session·Token 원문은 절대 기록하지 않는다(배포 Frontend–Backend 종단 검증.md §2, §8).
- **`AUTH_VALID_01` Rate Limit Bucket 주의**: `browser`와 `api` 스위트를 60초 이내에 이어서 돌리면 계정 Bucket(기본 용량 5)을 넘겨 뒤쪽 케이스가 잘못된 `429`로 실패할 수 있다. 자세한 내용과 대응은 [api/README.md](api/README.md#️-계정-rate-limit-bucket-주의) 참고.
- **Provisioning API는 어디서도 호출하지 않는다.** 실 테넌트 DB에 추적 안 되는 데이터가 생기는 걸 막기 위해 `AUTH-013`/`014`/`015`, `AUTH-030`/`031`, `FE-BE-010`/`014`, `SESS-004`/`005`의 Provisioning 폴백을 전부 삭제했다 — 정적 계정이 없으면 SKIP만 한다. (로컬 Docker Postgres에 계정을 만드는 `scripts/provision-local-rehearsal-account.mjs`는 별개다 — 실 테넌트 DB가 아니라 매번 새로 띄우는 격리된 로컬 컨테이너를 대상으로 하므로 이 금지와 무관하다.)

## 실행

전체 스위트를 한 번에 돌릴 때는 오케스트레이션 스크립트를, 특정 단계만 디버깅하거나 이해할 때는 수동 실행을 쓴다.

### 오케스트레이션 스크립트 사용법

개별 스위트를 하나씩 손으로 이어붙이지 않도록 `scripts/run-mandatory-gate.mjs`와 `scripts/run-full-gate.mjs` 두 오케스트레이션 스크립트를 추가했다.

- **`node scripts/run-mandatory-gate.mjs`** — 아래 순서로 실행한다:
  1. `FE-BE-001`~`006`(Playwright `tests/fe-be-mandatory.spec.ts`)
  2. `AUTH-001`~`004`,`010`,`020`~`024`(k6 `api/scenarios/auth-mandatory.js`)
  3. `AUTH-011`~`015`(k6 `api/scenarios/auth-account-nonexposure.js`)
  4. `SESS-001`~`003`,`006`,`007`(+`004`/`005` 조건부)(k6 `api/scenarios/session-flow.js`)
  5. `OPS-004`(`scripts/verify-edge-boundary.mjs`, 비파괴 관찰)
  6. 종합 판정(`scripts/build-combined-summary.mjs`)

  전부 파괴적 플래그 없이 안전 — CI에서 매 배포마다 완전 자동 실행해도 된다. `DORO_FRONTEND_ORIGIN`/`DORO_API_ORIGIN`/`DORO_AUTH_VALID_01_*` 등 필요한 값은 미리 export해둬야 한다(각 하위 실행이 `loadDeployEnv()`로 직접 요구).
- **`node scripts/run-full-gate.mjs`** — 위 전체에 이어 추가로 실행한다:
  1. `FE-BE-010`~`015`(Playwright `tests/fe-be-conditional.spec.ts`)
  2. `AUTH-030`/`031`/`033`/`034`(k6 `api/scenarios/auth-lockout-ratelimit.js`)
  3. `OPS-001`/`OPS-003`(`scripts/run-fault-injection.mjs`)
  4. `OPS-002`(`scripts/verify-provider-malformed-response.mjs`)
  5. `OPS-005`(`scripts/verify-partial-pod-failure.mjs`)
- **`OPS-001`/`OPS-003`은 `DORO_ENVIRONMENT`가 `local`로 시작할 때만 실행된다** — 그 외의(실 배포) 대상에서는 `RUN_FAULT_INJECTION_TESTS` 설정과 무관하게 자동으로 SKIP된다.
- `scripts/run-fault-injection.mjs`가 로컬 Docker 주소·컨테이너 이름에 하드코딩돼 있어 실 배포를 대상으로 실행할 수 없기 때문이다 — 잘못된(로컬) 대상을 검증하고도 실 배포를 검증한 것처럼 보이는 상황을 막기 위한 안전장치.
- **반대로 `OPS-002`/`OPS-005`는 `DORO_ENVIRONMENT`가 `local`로 시작하면 자동으로 SKIP된다** — 둘 다 `kubectl`로 실 EKS의 `store-access-api`를 직접 건드리는 실 배포 전용 스크립트라, 로컬 리허설 대상에서 실행할 이유가 없다.
- 이 머신에 다른 실제 클러스터를 가리키는 `kubectl` 컨텍스트가 우연히 설정돼 있다면, 로컬 리허설 도중 그 클러스터를 건드리는 일을 막기 위한 안전장치이기도 하다.
- `RUN_DESTRUCTIVE_AUTH_TESTS=true`로 `run-full-gate.mjs`를 돌리면 `AUTH-030`~`034` 단계 직전에 **약 65초를 그대로 대기한다** — 바로 앞에서 `AUTH-015`가 `AUTH_LOCKOUT_01`의 Rate Limit Bucket을 소진시켜 놓고 가기 때문에, 대기 없이 곧바로 `AUTH-030`을 돌리면 5회 연속 `401`이어야 할 응답 중 일부가 `429`로 나와 실제 결함이 아닌 순서 문제로 FAIL이 날 수 있다.
- 두 스크립트 다 `DORO_RUN_ID`를 자동 생성하거나 이미 export돼 있으면 그대로 쓴다.
- 한 단계가 실패해도 나머지 단계는 계속 진행한 뒤, 마지막에 종합 결과를 보여주고 실패가 하나라도 있으면 exit code 1로 끝난다.
- **`build-combined-summary.mjs` 단계의 exit code는 완화 판정(`frontBackConnected`)이 아니라 문서 §7 그대로의 엄격 판정(`passConnected`) 기준이다** — 둘이 갈리면 어느 §7 세부 조건이 걸렸는지 콘솔에 같이 출력된다.
- **파괴적 플래그는 오케스트레이터가 절대 자동으로 켜지 않는다** — `RUN_DESTRUCTIVE_AUTH_TESTS=true`(`AUTH-030`/`031`/`033`/`034`용), `RUN_FAULT_INJECTION_TESTS=true`(`FE-BE-012` 및 `OPS-001`/`002`/`003`/`005`의 `--confirm` 대신 재사용됨)를 실행 전 직접 export해야만 해당 케이스가 실제로 돈다. 안 켜져 있으면 무엇을 export해야 하는지 안내 문구를 찍고 그 단계만 SKIP한다.

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

### 손으로 직접 실행 (수동)

아래는 각 단계를 손으로 직접 이어붙이는 수동 실행 방법이다 — 전체 스위트를 한 번에 돌릴 때는 위 "오케스트레이션 스크립트 사용법"의 `run-mandatory-gate.mjs`/`run-full-gate.mjs`를 쓰는 쪽을 권장한다. 아래 수동 흐름은 시나리오 파일 하나만 단독 실행하거나, 각 오케스트레이션 단계가 내부적으로 정확히 무엇을 하는지 파악하거나, 전체를 다시 돌리지 않고 특정 단계만 디버깅할 때 유용하다.

browser와 api 결과를 나중에 `build-combined-summary.mjs`로 묶으려면 **셋 다 같은 `DORO_RUN_ID`**를
지정해서 실행해야 한다(안 주면 각자 자동 생성한 다른 runId를 써서 서로 못 찾는다).

```bash
export DORO_RUN_ID=run-$(date +%Y%m%d-%H%M%S)   # 세 실행이 전부 이 값을 쓴다

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
node api/lib/build-report.mjs /tmp/k6-auth-mandatory.log auth-mandatory \
  AUTH-001,AUTH-002,AUTH-003,AUTH-004,AUTH-010,AUTH-020,AUTH-021,AUTH-022,AUTH-023,AUTH-024

# 4) k6 세션 흐름 — SESS-004/005까지 돌리려면 AUTH_TEMP_PASSWORD_01/AUTH_PASSWORD_ROTATE_01
# 정적 계정도 필요(없으면 그 둘만 SKIP, Provisioning 폴백 없음)
DORO_API_ORIGIN=... DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... \
DORO_AUTH_VALID_01_PASSWORD=... \
DORO_AUTH_TEMP_PASSWORD_01_TENANT_CODE=... DORO_AUTH_TEMP_PASSWORD_01_LOGIN_ID=... DORO_AUTH_TEMP_PASSWORD_01_PASSWORD=... \
DORO_AUTH_PASSWORD_ROTATE_01_TENANT_CODE=... DORO_AUTH_PASSWORD_ROTATE_01_LOGIN_ID=... \
DORO_AUTH_PASSWORD_ROTATE_01_PASSWORD_A=... DORO_AUTH_PASSWORD_ROTATE_01_PASSWORD_B=... \
  k6 run --log-format=raw api/scenarios/session-flow.js > /tmp/k6-session-flow.log 2>&1
node api/lib/build-report.mjs /tmp/k6-session-flow.log session-flow SESS-001,SESS-002,SESS-003,SESS-006,SESS-007,SESS-004,SESS-005

# 5) 세 결과를 하나의 판정으로 묶는다
node scripts/build-combined-summary.mjs "$DORO_RUN_ID"
# → reports/<runId>.combined-summary.json, frontBackConnected(좁은 판정) 포함
```

`--log-format=raw`와 `build-report.mjs` 두 단계 다 필수다 — k6의 `handleSummary()`는 VU 실행과
별도의 격리된 JS VM에서 돌아서 실행 중 쌓은 결과를 볼 수 없다(로컬 리허설에서 실제로
`totalCases: 0`으로 재현·확인). 그래서 `api/lib/resultLogger.js`의 `record()`가 케이스마다
`console.log`로 한 줄씩 내보내는데, 이 줄은 stdout이 아니라 **stderr**로 나온다(k6 v2.2.0 실측
확인) — 위 명령들이 `2>&1`로 두 스트림을 합쳐서 파일로 받는 이유가 이것이다. `build-report.mjs`가
그 로그를 후처리해서 `reports/<runId>.<suite>.{results.jsonl,summary.json,junit.xml}`을 만든다 —
`api/README.md` 참고.

## 로컬 Docker Prod-like 리허설 모드

스크립트 자체 버그(셀렉터 깨짐, JSON 스키마 오타 등)를 실 배포 없이 미리 잡기 위한 부수적인 실행
모드다. 절차와 제약(정적 계정 8개는 이 모드로 검증 불가 등)은 [LOCAL_REHEARSAL.md](LOCAL_REHEARSAL.md)
참고 — **이 모드의 PASS는 배포 Frontend–Backend 종단 검증.md §9 "완료 조건"과 같은 의미가 아니다.**

## 참고 자료

구현 현황과 설계 배경 — 실행 자체엔 필요 없지만 맥락 파악에 참고한다.

### 구현 범위 (현재)

| 케이스 ID | 러너/파일 | 비고 |
|---|---|---|
| `FE-BE-001`~`006` | `browser/tests/fe-be-mandatory.spec.ts` | 필수 Gate |
| `AUTH-001`~`004`,`010`,`020`~`024` | `api/scenarios/auth-mandatory.js` | 필수 Gate |
| `AUTH-011`~`014` | `api/scenarios/auth-account-nonexposure.js` | 각각 전용 정적 계정 필요(없으면 SKIP) |
| `AUTH-015` | 〃 | 정적 계정 + `RUN_DESTRUCTIVE_AUTH_TESTS=true` 둘 다 필요 |
| `SESS-001`~`003`,`006`,`007` | `api/scenarios/session-flow.js` | `AUTH_VALID_01` 사용 |
| `SESS-004` | 〃 | `AUTH_TEMP_PASSWORD_01` 전용 |
| `SESS-005` | 〃 | `AUTH_PASSWORD_ROTATE_01` 전용(A/B 비밀번호 중 현재 값을 스스로 판별) |
| `AUTH-030`,`031`,`033`,`034` | `api/scenarios/auth-lockout-ratelimit.js` | `RUN_DESTRUCTIVE_AUTH_TESTS=true` 필요, `030`/`031`은 `AUTH_LOCKOUT_01` 전용 |
| `FE-BE-010`~`015` | `browser/tests/fe-be-conditional.spec.ts` | `010`/`014`는 정적 계정 필요, 아직 실행 검증 전 |
| `OPS-001`,`OPS-003` | `scripts/run-fault-injection.mjs` | 로컬 Docker 전용, `--confirm` 필요 |
| `OPS-004` | `scripts/verify-edge-boundary.mjs` | 비파괴 관찰, 실 AWS 배포 PASS 확인됨 |
| `OPS-002` | `scripts/verify-provider-malformed-response.mjs` | `--confirm` 필요, 실 배포 실행 미검증(EKS 접근 없음) |
| `OPS-005` | `scripts/verify-partial-pod-failure.mjs` | `--confirm` 필요, 실 배포 실행 미검증(EKS 접근 없음) |

정적 계정 8개(`AUTH_LOCKOUT_01`/`AUTH_INACTIVE_EMPLOYEE_01`/`AUTH_INACTIVE_TENANT_01`/
`AUTH_ROLE_OWNER_01`/`MANAGER_01`/`STAFF_01`/`AUTH_TEMP_PASSWORD_01`/`AUTH_PASSWORD_ROTATE_01`)를
쓰는 케이스는 전부 **Provisioning API 폴백 없이** 해당 계정이 없으면 `SKIP_PRECONDITION`이다(`FE-BE-014`는
OWNER/MANAGER/STAFF 세 계정이 모두 있어야 실행). 실 테넌트 DB에 Provisioning API로 계정을 만드는
경로는 전부 삭제했고, 이 8개 케이스는 로컬 리허설로도 검증할 수 없다 — 정적 계정 요구사항은
`Docs/Specifications/운영·배포/"배포 검증용 테스트 계정 요청.md"` 참고.

두 러너 결과를 하나로 묶는 `scripts/build-combined-summary.mjs`, 스위트를 한 번에 이어 실행하는
`scripts/run-mandatory-gate.mjs`/`scripts/run-full-gate.mjs`, Deployment Identity를 채우는
`scripts/resolve-deployment-identity.mjs`는 각각 위 "실행"/"준비" 절 참고.

**알아둬야 하는 백엔드 동작**:
- 계정 Rate Limit Bucket 용량(5)이 잠금 임계치(5회)와 같아, 잠금 직후 요청은 `401` 또는 `429` 둘
  다 나올 수 있다 — `AUTH-015`/`031`은 두 상태 모두 PASS로 인정한다.
- `PasswordPolicyValidator`는 비밀번호에 `loginId`가 부분 문자열로 포함되면 거부한다.
- 비밀번호 변경은 성공하는 순간 그 계정의 기존 Session을 전부 무효화한다(`SESS-005`가 검증하는 동작).
- `EmployeeController`의 직원 생성/상태 변경은 행위자(OWNER) 본인이 이미 영구 비밀번호로 전환했을 것을 요구한다.

`AUTH-032`(잠금 단계 1→2→4→8→15분 증가)는 clock 대기 비용이 커서 미구현 — 자세한 사유는 아래
"미구현 항목 설명" 참고.

### 주의사항

- **AUTH-034 공유 네트워크 경고**: `AUTH-034`를 실 배포(dev/stage/prod) 대상으로 돌릴 계획이라면 반드시 먼저 `api/README.md`의 경고를 읽을 것 — 공유 네트워크에서 돌리면 같은 IP를 쓰는 다른 실사용자까지 막힐 수 있다.
- **EKS 접근 미검증 경고**: 아래 스크립트는 전부 실 EKS 클러스터 접근이 필요한데, 이 리포를 작업한 환경에는 그 접근 권한이 없어서 실제로 실행해 검증하지 못했다. 최초 실행 전 결과를 직접 확인해야 한다.
  - `FE-BE-012`(`browser/tests/fe-be-conditional.spec.ts`)의 실 배포 경로
  - `scripts/run-fault-injection.mjs`의 `OPS-001`/`OPS-003`(로컬 전용, 실 배포 미대응)
  - `scripts/verify-provider-malformed-response.mjs`(`OPS-002`)
  - `scripts/verify-partial-pod-failure.mjs`(`OPS-005`)
- **`OPS-005`는 파괴적이다**: 실제로 `store-access-api` Pod 1개를 `kubectl delete pod`로 지운다 — 승인된 점검 시간에만, `--confirm` 필요.
- **`OPS-002`는 영향 범위가 넓다** — 승인된 점검 시간에만, `--confirm` 필요.
  - 실 `store-access-api` Service의 `spec.selector`를 디코이 Pod로 임시 교체한다(재시작이 필요 없고 즉시 반영·즉시 원복되는 방식을 택했다).
  - `STORE_ACCESS_INTERNAL_BASE_URL` 하나를 edge-api의 로그인·Session Context·Kiosk·Management·비밀번호 변경 Forwarder 6개가 전부 공유하기 때문에, 교체돼 있는 동안에는 store-access-api를 쓰는 edge-api의 모든 통신이 함께 영향을 받는다(`OPS-005`보다 넓은 범위).
- **정적 계정 8개 없으면 SKIP, 대체 경로 없음** — 위 "구현 범위 (현재)" 참고.
- **`OPS-005`의 `observedSinglePodWindow`는 보조 지표다**
  - PASS해도 이 값이 `false`면 대체 Pod가 너무 빨리 Ready가 돼서 "정말로 Pod 1개만 서비스하던 순간"을 직접 관측하지 못했다는 뜻이다(서비스가 계속 정상 응답했다는 핵심 판정 자체는 여전히 유효하다).
  - 결과를 엄격하게 확인해야 하면 JSONL의 이 필드를 같이 봐야 한다.
- **`OPS-004`의 TLS/네트워크 오류 구분 로직은 아직 실 클러스터로 검증 못함**
  - 내부 ALB가 실수로 인터넷에 노출된 경우(TLS 인증서 오류로 응답이 옴)와 정상적으로 차단된 경우(연결 자체가 실패)를 구분하는 분기인데, 실제 TLS 오류 케이스로는 아직 검증되지 않았다.
  - 위 "구현 범위 (현재)" 표의 `OPS-004` 실 배포 PASS 기록은 이 분기가 생기기 전 코드 기준이다.

### 조건부/파괴적 항목을 구분한 이유

이 구분은 `Docs/Specifications/운영·배포/배포 Frontend–Backend 종단 검증.md` 문서 자체의 구조를 그대로 따른다 — §3 필수 Browser Gate + §5 공통 계약의 배포 재검증(대표 Slice) + §6의 비파괴 항목(`OPS-004`)만 "필수 게이트"(`run-mandatory-gate.mjs`)에 넣었다. 반대로 §4 조건부 Browser 시나리오, §5의 잠금/Rate Limit·Provider 오응답(`OPS-002`), §6의 Pod 장애 주입(`OPS-005`)처럼 실제 서비스·계정·Pod·Service 라우팅에 실질적인 영향을 주는 항목은 "전체 게이트"(`run-full-gate.mjs`)로 분리해, 명시적 승인(플래그 또는 `--confirm`) 없이는 절대 자동으로 돌지 않도록 설계했다.

### 미구현 항목 설명

#### A. 기존 항목과 겹쳐서 별도 구현하지 않음

- `AUTH-035`(보충 시간 후 재요청) — 별도 스크립트가 필요 없다. 계정 Bucket 리필과 잠금 만료 시점이 거의 같은 주기(둘 다 ~60초)라, 충분히 기다린 뒤 재요청하면 정상 로그인(`200`)이 나오는 것이 `AUTH-031` 케이스 자체에서 이미 확인된다.
- 재인증 UI 테스트, Provisioning API 외부 도달성 확인 — 검토 결과 불필요하다고 판단해 배제.

#### B. 코드로 구현하기 어려운 상황 (설계/인프라 자체가 막힘)

- `OPS-003`(Redis 장애 실 배포 재현) — 실 배포의 Redis는 K8s Pod가 아니라 관리형 AWS ElastiCache라 `kubectl`로 건드릴 대상이 없다. NetworkPolicy 교체나 AWS 보안그룹 변경이 필요한데 둘 다 `doro-erp-e2e` 테스트 스크립트의 범위를 넘어서(`Doro-ERP-Infra`/`Doro-ERP-GitOps` 쪽 결정 필요) 보류 중이다.

#### C. 실행 비용 때문에 제외

- `AUTH-032`(잠금 단계 1→2→4→8→15분 증가) — 기술적으로는 구현 가능하지만 실제 시계로 15분 이상 대기해야 해서 자동화 스위트에 넣지 않았다.

**참고**: `FE-BE-012`/`OPS-001`/`OPS-002`/`OPS-005`는 위 A/B/C와 다르다 — "미구현"이 아니라 코드는
이미 완성돼 있고, EKS 접근 권한이 없어서(위 "주의사항"의 EKS 접근 미검증 경고 참고) **실행 검증**만
못 한 상태다.

#### OPS-002 구현 메모

`OPS-002`(Provider 미승인 Cookie·Body → Edge `503` Fail-Closed)는 HMAC 서명이 아니라 순수 응답
모양(Body 3개 필드, Cookie 허용목록·속성)만 검증한다 — `store-access-api` Service의
`spec.selector`를 임시 디코이 Pod로 바꾸는 것만으로 구현 가능하다(위 "주의사항"의 영향 범위 경고 참고).
