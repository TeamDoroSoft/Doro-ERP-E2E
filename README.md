# doro-erp-e2e

`Doro ERP Frontend–Backend 실제 배포 종단 테스트 계획 보고서`
(`ERP/Docs/의사결정/Doro ERP Frontend–Backend 배포 종단 테스트 계획 보고서.md`, v2.1)를 구현하는 배포 종단(End-to-End) 테스트 러너.

`Doro-ERP-Front`, `Doro-ERP-Infra`, `Doro-ERP-Service`, `Docs`, `Doro-ERP-GitOps`와 마찬가지로 독립 git 저장소이며,
`Final_Project/CLAUDE.md`의 브랜치 네이밍(`feature/`, `bugfix/`, `refactor/`, `hotfix/`)과 리뷰 워크플로우(Claude 구현 → Codex 로컬 diff 리뷰)를 동일하게 따른다.

## 구조

```
doro-erp-e2e/
├── browser/            # Playwright 배포 E2E — FE-BE-* (실제 배포 화면, Network 관찰 포함)
│   ├── tests/
│   └── lib/
├── api/                # k6 배포 API Runner — AUTH-*, SESS-*, OPS-*
│   ├── scenarios/
│   └── lib/
├── shared/             # 두 러너가 공유하는 §7 결과 스키마/판정 규칙 정의
├── reports/            # 실행 산출물 (runId별, gitignore 대상)
├── .env.deploy-e2e.example   # 환경변수 템플릿 (플레이스홀더만, 실값 커밋 금지)
```

`browser`(Playwright)와 `api`(k6)를 같은 저장소 안에 두되 도구는 분리한다 — k6 Browser 모듈은 `page.on('request')`/`page.route()`/CDP 접근을 지원하지 않아
`FE-BE-002`~`006`이 요구하는 Network 계층 관찰(§5.1, §6.2)을 충족할 수 없기 때문 ([grafana/k6#4020](https://github.com/grafana/k6/issues/4020)). 자세한 도구 선정 근거는 보고서 §8.1 참고.

## 구현 범위 (현재)

**필수 Gate + SESS-004/005** — `browser/tests/fe-be-mandatory.spec.ts`(`FE-BE-001`~`006`), `api/scenarios/auth-mandatory.js`(`AUTH-001`~`004`,`010`,`020`~`024`), `api/scenarios/session-flow.js`(`SESS-001`,`002`,`004`,`005`).
`SESS-004`/`005`는 `AUTH_VALID_01`이 아니라 이 케이스 전용 1회용 테넌트+OWNER를 Provisioning API로 직접 만들어서 쓴다
(`api/lib/provisioning.js`) — Provisioning 자격증명(`PROVISIONING_ORIGIN`, `STORE_ACCESS_PROVISIONING_USERNAME/PASSWORD`)이
없으면 이 두 케이스만 `SKIP_PRECONDITION`으로 건너뛴다(실 AWS 대상 실행처럼 일부러 안 주는 경우 대비).

두 러너 결과를 하나로 묶는 `scripts/build-combined-summary.mjs`도 추가했다 — browser/api 실행에 같은
`DORO_RUN_ID`를 지정해야 서로 짝지어진다(아래 "실행" 참고).

**잠금·Rate Limit(`AUTH-030`,`031`,`033`,`034`)과 장애 주입(`OPS-001`,`003`)도 추가했다** — 둘 다
로컬 리허설 전용이며 기본으로는 실행되지 않는다(안전 장치, 보고서 §5.5·§5.7 그대로):

- `api/scenarios/auth-lockout-ratelimit.js`는 `RUN_DESTRUCTIVE_AUTH_TESTS=true`를 명시해야 실행된다.
  `AUTH-030`/`031`(5회 실패 계정 잠금)은 이 케이스 전용 1회용 계정을 새로 만들어 쓴다.
  **실측으로 확인한 중요한 사실**: 계정 Rate Limit Bucket 용량(5)이 잠금 임계치(5회)와 정확히 같아서,
  "잠금 직후" 요청은 문서가 적은 `401`이 아니라 `429 AUTH_RATE_LIMITED`로 막힌다(Bucket이 먼저
  소진되기 때문) — 둘 다 "안전하게 거절, 상세 비노출"이라는 실제 의도는 만족하므로 `AUTH-031`은
  이 두 상태 모두를 PASS로 받아들이도록 짰다. 자세한 내용은 스크립트 안의 주석과 `api/README.md` 참고.
- `scripts/run-fault-injection.mjs OPS-001|OPS-003 --confirm`은 로컬 Docker 컨테이너
  (`store-access-api`/`redis`)를 실제로 멈췄다 올리며 `503` Fail-Closed와 복구를 확인한다.
  `--confirm` 없이는 무엇도 건드리지 않고 즉시 종료한다.

**계정 존재 비노출(`AUTH-011`~`015`)도 추가했다** — `api/scenarios/auth-account-nonexposure.js`.
`AUTH-011`/`012`(존재하지 않는 loginId/tenantCode)는 Fixture가 필요 없어 항상 실행되고,
`AUTH-013`(INACTIVE 직원)/`014`(INACTIVE 테넌트)는 `provisioningAvailable`만 있으면 실행되고,
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

잠금 단계 증가(`AUTH-032`)와 조건부 화면 반응(`FE-BE-010`~`015`)은 실제 clock 대기 비용이 크거나(전자)
아직 손 안 대서(후자) 없다(보고서 §5.2, §5.5).

`scripts/resolve-deployment-identity.mjs`도 추가했다 — 보고서 §7.3의 `deployment`(Revision) 4개 필드를
실제 AWS·GitOps에서 읽어와 `.env.deployment-identity.local`에 채운다. 자세한 내용은 바로 아래
"Deployment Identity(Revision) 채우기" 참고.

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

## 실행 전제

- 실제 값은 `.env.deploy-e2e.local`(gitignore 대상) 또는 CI Secret Store에만 넣는다. 커밋 금지.
- `AUTH_VALID_01` = `sample-store`/`owner` (정상 계정). 잠금·비활성·임시비밀번호 등 조건부 Fixture는 준비되는 대로 추가.
- `FE-BE-003`/`SESS-001`이 공통으로 쓰는 비파괴 조회 API는 `GET /api/v1/orders`로 확정했다 — 로그인 성공 시 실제로 이동하는 `/pos/orders` 화면이 `onMounted`에서 자동 호출하고, Role 제한이 없다([PosOrdersView.vue](../Doro-ERP-Front/src/views/PosOrdersView.vue), [EdgeOrderController.java](../Doro-ERP-Service/apps/edge-api/src/main/java/com/dorosoft/erp/edge/presentation/EdgeOrderController.java)).
- 배포 전용 실행에서는 Mock, `page.route().fulfill()`, 인증 Session 사전 주입을 금지한다(보고서 §8.1).
- 결과 로그는 `reports/<runId>/results.jsonl`(browser) 및 `reports/<runId>.<suite>.results.jsonl`(api, k6는 하위 디렉터리를 자동 생성 못 해서 평평한 파일명을 씀)을 정본으로 하며, Password·Cookie·Session·Token 원문은 절대 기록하지 않는다(보고서 §4.2, §7.4).
- **`AUTH_VALID_01` Rate Limit Bucket 주의**: `browser`와 `api` 스위트를 60초 이내에 이어서 돌리면 계정 Bucket(기본 용량 5)을 넘겨 뒤쪽 케이스가 잘못된 `429`로 실패할 수 있다. 자세한 내용과 대응은 [api/README.md](api/README.md#️-계정-rate-limit-bucket-주의-보고서-25) 참고.

## 실행

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

# 4) k6 세션 흐름 — SESS-004/005까지 돌리려면 Provisioning 자격증명도 필요(없으면 그 둘만 Skip)
DORO_API_ORIGIN=... DORO_AUTH_VALID_01_TENANT_CODE=... DORO_AUTH_VALID_01_LOGIN_ID=... \
DORO_AUTH_VALID_01_PASSWORD=... PROVISIONING_ORIGIN=... \
STORE_ACCESS_PROVISIONING_USERNAME=... STORE_ACCESS_PROVISIONING_PASSWORD=... \
  k6 run --log-format=raw api/scenarios/session-flow.js > /tmp/k6-session-flow.log 2>&1
node api/lib/build-report.mjs /tmp/k6-session-flow.log session-flow SESS-001,SESS-002,SESS-003,SESS-004,SESS-005

# 5) 세 결과를 하나의 판정으로 묶는다
node scripts/build-combined-summary.mjs "$DORO_RUN_ID"
# → reports/<runId>.combined-summary.json, frontBackConnected(좁은 판정) 포함
```

`--log-format=raw`와 `build-report.mjs` 두 단계 다 필수다 — k6의 `handleSummary()`는 VU 실행과
별도의 격리된 JS VM에서 돌아서 실행 중 쌓은 결과를 볼 수 없다(로컬 리허설에서 실제로
`totalCases: 0`으로 재현·확인). 그래서 `api/lib/resultLogger.js`의 `record()`가 케이스마다
`console.log`로 한 줄씩 stdout에 내보내고, `build-report.mjs`가 그 로그를 후처리해서
`reports/<runId>.<suite>.{results.jsonl,summary.json,junit.xml}`을 만든다 — `api/README.md` 참고.

## 로컬 Docker Prod-like 리허설 모드

### 용어 정의 — "로컬 테스트"란

이 문서에서 "로컬 테스트"/"로컬 리허설"은 **정확히** 다음을 뜻한다: `Doro-ERP-Service/environments/local`의
Docker Compose로 6개 Spring Boot 서비스를 `prod` Profile + 자체 서명 TLS로 내 컴퓨터에 띄우고, 그걸 대상으로
`doro-erp-e2e`를 실행하는 것. 대상 Origin은 `https://localhost:8080`(Edge)이고, 계정은 `provision-local-rehearsal-account.mjs`가
그때그때 만든 1회용 테넌트다.

이건 실제 dev 배포(`doro.minseok.click`, CloudFront→ALB→EKS 실 인프라)를 대상으로 돌리는 것과 **다른 모드**다 —
후자는 `DORO_FRONTEND_ORIGIN`/`DORO_API_ORIGIN`을 `https://doro.minseok.click`으로 주고, AWS 자격증명으로
`scripts/resolve-deployment-identity.mjs`를 먼저 돌려 Revision 정보를 채운 뒤 실행한다. **로컬 리허설은 스크립트
자체 버그(셀렉터 깨짐·JSON 스키마 오타 등)를 미리 잡기 위한 것일 뿐, 보고서 §11.2의 "실제 배포 검증 완료"를
대체하지 않는다** — 아래 "이 모드가 증명하지 못하는 것"을 반드시 읽을 것.

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

`DORO_ENVIRONMENT`가 `local`로 시작할 때만 `http://localhost`가 예외로 허용된다(그 외에는 보고서 §4.3에
따라 여전히 HTTPS 강제, `browser/lib/env.ts`의 `requireOrigin` 참고). k6는 Vite를 거치지 않고 Edge
Container를 직접 때리므로 `DORO_API_ORIGIN`은 그대로 HTTPS이고, 자체 서명 인증서라
`--insecure-skip-tls-verify`가 추가로 필요하다(실제 dev/stage/prod에는 절대 쓰지 않음).

```bash
export DORO_RUN_ID=run-$(date +%Y%m%d-%H%M%S)   # browser/api 세 실행 전부 이 값을 쓴다

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
node api/lib/build-report.mjs /tmp/k6-auth-mandatory.log auth-mandatory \
  AUTH-001,AUTH-002,AUTH-003,AUTH-004,AUTH-010,AUTH-020,AUTH-021,AUTH-022,AUTH-023,AUTH-024

# k6 SESS-004/005는 이 계정과 무관한 1회용 Fixture를 직접 만들어서 쓰므로 Provisioning
# 자격증명도 넘긴다 — PROVISIONING_ORIGIN은 store-access-api에 직접(Edge 아님).
PROVISIONING_ORIGIN=https://localhost:8081 \
STORE_ACCESS_PROVISIONING_USERNAME=... STORE_ACCESS_PROVISIONING_PASSWORD=... \
DORO_API_ORIGIN=https://localhost:8080 \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/session-flow.js \
  > /tmp/k6-session-flow.log 2>&1
node api/lib/build-report.mjs /tmp/k6-session-flow.log session-flow SESS-001,SESS-002,SESS-003,SESS-004,SESS-005

# 세 결과를 하나로 묶는다
node scripts/build-combined-summary.mjs "$DORO_RUN_ID"
```

2026-08-24에 이 순서 그대로 로컬 Docker Prod-like 스택에 붙여 `FE-BE-001`~`006` 6/6, `AUTH-*` 10/10,
`SESS-001/002/004/005` 4/4, 그리고 셋을 묶은 `combined-summary.json`의 `frontBackConnected: true`까지
전부 확인했다. 이 과정에서 실제 버그 3개를 로컬 리허설로 잡았다:
- `FE-BE-006`의 `page.waitForURL('**/pos/login')`이 로그아웃 후 `goBack()`으로 돌아갈 때 실제 URL이
  `/pos/login?redirect=/pos/orders`(Router Guard가 Query String을 붙임)라 매칭에 실패해 Timeout까지
  걸렸다 — `**/pos/login**`로 수정.
- k6 `handleSummary()`가 VU 실행과 격리된 별도 VM에서 돌아 결과를 못 봄 — `console.log` + 후처리로 재설계.
- k6가 `reports/<runId>/` 같은 없는 하위 디렉터리에 자동으로 mkdir를 안 해줌 — 평평한 파일명으로 변경.

### 잠금·Rate Limit·장애 주입 (선택, 기본 비활성)

```bash
# AUTH-030/031/033/034 — 5회 실패 계정 잠금과 계정·IP Rate Limit Bucket 소진
RUN_DESTRUCTIVE_AUTH_TESTS=true \
DORO_API_ORIGIN=https://localhost:8080 \
DORO_AUTH_VALID_01_TENANT_CODE=unused DORO_AUTH_VALID_01_LOGIN_ID=unused DORO_AUTH_VALID_01_PASSWORD=unused \
PROVISIONING_ORIGIN=https://localhost:8081 \
STORE_ACCESS_PROVISIONING_USERNAME=... STORE_ACCESS_PROVISIONING_PASSWORD=... \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/auth-lockout-ratelimit.js \
  > /tmp/k6-lockout.log 2>&1
node api/lib/build-report.mjs /tmp/k6-lockout.log auth-lockout-ratelimit AUTH-030,AUTH-031,AUTH-033,AUTH-034

# OPS-001/003 — Store Access·Redis 컨테이너를 실제로 멈췄다 올린다 (--confirm 없이는 아무것도 안 함)
node scripts/run-fault-injection.mjs OPS-001 --confirm
node scripts/run-fault-injection.mjs OPS-003 --confirm
```

`AUTH_VALID_01` 값은 이 스크립트가 실제로 쓰지는 않지만 `loadDeployEnv()`가 공통으로 요구해서 더미 값을
넣어야 한다. 2026-08-24에 로컬 Docker Prod-like 스택에서 `AUTH-030/031/033/034` 4/4,
`OPS-001`/`OPS-003` 둘 다 PASS(장애 주입 → `503 LOGIN_UNAVAILABLE` → 컨테이너 재기동 → 정상 `401` 복구)까지
확인했다. 가장 중요한 발견은 `AUTH-031`이다 — 계정 Rate Limit Bucket 용량(5)이 잠금 임계치(5회 실패)와
정확히 같아서, 5번째 실패 직후 요청은 **문서가 적은 `401`이 아니라 `429 AUTH_RATE_LIMITED`**로 막힌다
(정확한 비밀번호를 넣어도 마찬가지). Bucket이 먼저 소진되기 때문이며, 로컬 기본값(용량 5/분당 1)이
실제 운영 기본값과 같으므로 운영에서도 같은 현상이 예상된다.

### 이 모드가 증명하지 못하는 것

`Doro-ERP-Service/environments/local/README.md`가 스스로 명시한 한계를 그대로 물려받는다: 실제
IAM/Pod Identity, ALB·WAF, Security Group, Managed RDS·ElastiCache·SQS, 운영 인증서, CloudFront,
Auto Scaling·Backup·Failover는 전혀 검증하지 않는다. 여기서 전부 PASS해도 `summary.json`의
`environment`가 `local-prod-like`로 찍혀 있는 한, 보고서 §11.2의 "실제 배포 검증 완료"·`PASS_CONNECTED`와
같은 의미가 아니다 — 기존 `tests/system`/`AuthControllerIntegrationTest` 같은 "CODE_COMPLETE" 레벨
검증과 같은 급으로 취급한다.
