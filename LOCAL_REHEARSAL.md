# 로컬 Docker Prod-like 리허설 모드

`doro-erp-e2e`(`README.md` 참고)를 실 AWS 배포 대신 로컬 Docker 스택을 대상으로 돌리는 방법이다.
**스크립트 자체 버그(셀렉터 깨짐, JSON 스키마 오타 등)를 실 배포 없이 미리 잡기 위한 부수적인 수단일
뿐**, 배포 Frontend–Backend 종단 검증.md §9의 "완료 조건"을 대체하지 않는다 — 아래 "이 모드가
증명하지 못하는 것"을 반드시 읽을 것.

## 용어 정의 — "로컬 테스트"란

이 문서에서 "로컬 테스트"/"로컬 리허설"은 **정확히** 다음을 뜻한다: `Doro-ERP-Service/environments/local`의
Docker Compose로 6개 Spring Boot 서비스를 `prod` Profile + 자체 서명 TLS로 내 컴퓨터에 띄우고, 그걸 대상으로
`doro-erp-e2e`를 실행하는 것. 대상 Origin은 `https://localhost:8080`(Edge)이고, 계정은 `provision-local-rehearsal-account.mjs`가
그때그때 만든 1회용 테넌트다.

이건 실제 dev 배포(`doro.minseok.click`, CloudFront→ALB→EKS 실 인프라)를 대상으로 돌리는 것과 **다른 모드**다 —
후자는 `DORO_FRONTEND_ORIGIN`/`DORO_API_ORIGIN`을 `https://doro.minseok.click`으로 주고, AWS 자격증명으로
`scripts/resolve-deployment-identity.mjs`를 먼저 돌려 Revision 정보를 채운 뒤 실행한다(`README.md` "준비" 절 참고).

**정적 계정 8개가 필요한 케이스(`AUTH-013`/`014`/`015`, `AUTH-030`/`031`, `FE-BE-010`/`014`, `SESS-004`/`005`)는
로컬 리허설로 검증할 수 없다.** 이 리포는 애초에 실 AWS 배포 검증이 본래 목적이고 로컬 리허설은 스크립트
버그를 미리 잡기 위한 부수적인 수단인데, 그 부수적인 용도를 위해 Provisioning API로 실 테넌트 DB에
계정을 만드는 경로를 남겨두지 않기로 했다(`README.md`의 "실행 전제" 참고) — 정적 계정은 실 배포 대상 전용이라
로컬 Postgres엔 존재하지 않는다. 아래 명령들 중 이 8개 케이스에 해당하는 부분은 전부 `SKIP_PRECONDITION`으로만
끝난다.

## 사전 준비: `Doro-ERP-Service`의 기존 Prod-like Docker 스택

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

## Frontend: Vite dev 서버로 연결 (가벼운 방식 — Dockerfile 새로 안 만듦)

Vite dev 서버의 proxy(`/api` → Edge)가 자체 서명 인증서를 거부한다. `NODE_EXTRA_CA_CERTS`(인증서를
신뢰 CA로 등록)와 `NODE_TLS_REJECT_UNAUTHORIZED=0`(Node 프로세스 전역 TLS 검증 우회)은 이 환경에서
동작하지 않는다 — Vite의 proxy 엔진(`http-proxy`)에는 적용되지 않기 때문.

**동작하는 방법은 `Doro-ERP-Front/vite.config.ts`의 proxy 옵션에 `secure: false`를 추가하는 것뿐이다**
— Vite proxy가 자체 서명 대상을 위해 제공하는 전용 옵션이다. 이건 **로컬 리허설 전용 임시 변경**이라 `Doro-ERP-Front`에 커밋하지 않는다 —
`doro-erp-e2e`는 이 폴더 밖 코드를 건드리지 않는다는 원칙(`README.md` 상단 참고) 때문에, 리허설을 시작할 때
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

## 계정 준비: `scripts/provision-local-rehearsal-account.mjs`

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
`.env.local-rehearsal.local`(gitignore 대상, `.env.*.local` 패턴)에만 기록한다.

**Rate Limit 토큰 비용**: 스크립트가 신규 계정을 만들 때 로그인 1회(임시 비밀번호 확인용)만 쓴다 —
영구 비밀번호 재검증 로그인은 Rate Limit 토큰을 아끼려고 일부러 생략했다. 그래도 계정 Bucket 용량이 5뿐이라,
Provisioning 직후 곧바로 `FE-BE-002~006`(로그인 5회 필요) 풀 스위트를 돌리면 여전히 1개 모자라
마지막 케이스가 `429`로 막힐 수 있다 — **Provisioning 후 최소 60초 대기하거나(1개 보충), 스위트마다
별도 계정을 새로 만드는 쪽이 안전하다** (`.env.local-rehearsal.local`을 지우고 스크립트를 다시
실행하면 새 계정이 생긴다).

## `doro-erp-e2e` 실행

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

# k6 (repo 루트에서) — --log-format=raw + build-report.mjs가 필요한 이유는 README.md의 "실행" 절 참고
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

위 8개 정적 계정 없이 이 순서대로 돌리면 `AUTH-013`/`014`/`015`, `SESS-004`/`005`는 `SKIP_PRECONDITION`으로
끝나고 나머지 필수 케이스는 정상 실행된다(위 "정적 계정 8개가 필요한 케이스" 참고).

## 잠금·Rate Limit·장애 주입 (선택, 기본 비활성)

```bash
# AUTH-030/031/033 — 5회 실패 계정 잠금과 계정 Rate Limit Bucket 소진.
# AUTH-030/031은 AUTH_LOCKOUT_01 정적 계정이 로컬엔 없어서 SKIP_PRECONDITION으로 끝난다 —
# 033은 계정이 필요 없는 케이스라 그대로 돈다.
RUN_DESTRUCTIVE_AUTH_TESTS=true \
DORO_API_ORIGIN=https://localhost:8080 \
DORO_AUTH_VALID_01_TENANT_CODE=unused DORO_AUTH_VALID_01_LOGIN_ID=unused DORO_AUTH_VALID_01_PASSWORD=unused \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/auth-lockout-ratelimit.js \
  > /tmp/k6-lockout.log 2>&1
node api/lib/build-report.mjs /tmp/k6-lockout.log auth-lockout-ratelimit AUTH-030,AUTH-031,AUTH-033

# AUTH-034 — 격리된 로컬 경로의 Source IP Bucket 수렴 진단. full gate에는 포함되지 않는다.
RUN_AUTH_IP_DIAGNOSTIC=true \
DORO_API_ORIGIN=https://localhost:8080 \
DORO_AUTH_VALID_01_TENANT_CODE=unused DORO_AUTH_VALID_01_LOGIN_ID=unused DORO_AUTH_VALID_01_PASSWORD=unused \
  k6 run --insecure-skip-tls-verify --log-format=raw api/scenarios/auth-ip-ratelimit-diagnostic.js \
  > /tmp/k6-auth-ip-diagnostic.log 2>&1
node api/lib/build-report.mjs /tmp/k6-auth-ip-diagnostic.log AUTH-ip-diagnostic AUTH-034

# OPS-001/003 — Store Access·Redis 컨테이너를 실제로 멈췄다 올린다 (--confirm 없이는 아무것도 안 함)
node scripts/run-fault-injection.mjs OPS-001 --confirm
node scripts/run-fault-injection.mjs OPS-003 --confirm
```

`AUTH_VALID_01` 값은 이 스크립트가 실제로 쓰지는 않지만 `loadDeployEnv()`가 공통으로 요구해서 더미 값을
넣어야 한다. `AUTH-030`/`031`은 `AUTH_LOCKOUT_01` 정적 계정이 로컬엔 없어 `SKIP_PRECONDITION`으로
끝난다. 계정 Rate Limit Bucket 용량(5)이 잠금 임계치(5회)와 같은 것과 그로 인한 `401`/`429` 판정
기준은 `README.md`의 "구현 범위 (현재)" 참고. **실 배포 대상으로 돌릴 계획이라면 `README.md`의
"주의사항"에 있는 AUTH-034 공유 네트워크 경고를 반드시 먼저 읽을 것** — 로컬(자체 서명 인증서, 격리된 Docker
네트워크)에서는 안전하다. 이 로컬 진단은 실제 CloudFront·ALB 헤더 전달 형태까지 증명하지 않는다.

## 이 모드가 증명하지 못하는 것

`Doro-ERP-Service/environments/local/README.md`가 스스로 명시한 한계를 그대로 물려받는다: 실제
IAM/Pod Identity, ALB·WAF, Security Group, Managed RDS·ElastiCache·SQS, 운영 인증서, CloudFront,
Auto Scaling·Backup·Failover는 전혀 검증하지 않는다. 여기서 전부 PASS해도 `summary.json`의
`environment`가 `local-prod-like`로 찍혀 있는 한, 배포 Frontend–Backend 종단 검증.md §9의 "완료 조건"·
`PASS_CONNECTED`와 같은 의미가 아니다 — 기존 `tests/system`/`AuthControllerIntegrationTest` 같은 "CODE_COMPLETE" 레벨
검증과 같은 급으로 취급한다.
