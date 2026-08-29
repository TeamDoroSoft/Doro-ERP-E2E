# Doro ERP E2E

실제 배포된 Doro ERP의 Frontend → CloudFront → Edge → 서비스 API 경로를 검증하는 E2E 테스트 저장소입니다.
Playwright는 사용자 화면 흐름을, k6는 API 연결성과 인증·세션 계약을 검증합니다.

## 폴더 구조

```text
Doro-ERP-E2E/
├── browser/                 # Playwright 화면 E2E (FE-BE-*)
│   ├── tests/
│   └── lib/
├── api/                     # k6 API E2E (AUTH-*, SESS-*, QUEUE-*, CATALOG-*)
│   ├── scenarios/
│   └── lib/
├── scripts/
│   ├── gates/               # 배포 검증, AWS 사전 점검, EKS 장애 주입
│   ├── local-rehearsal/     # 로컬 Docker 리허설 전용 작업
│   ├── reporting/           # 실행 결과 통합 판정
│   └── lib/                 # 공통 오케스트레이션 유틸리티
├── shared/                  # 결과 JSONL 스키마
├── reports/                 # 실행 결과 (gitignore)
└── .env.deploy-e2e.example  # 배포 E2E 환경변수 템플릿
```

## 사용 스펙

| 구분 | 도구 | 대상 | 역할 |
| --- | --- | --- | --- |
| 화면 E2E | Playwright | 실제 배포 Frontend | 로그인, 화면 전환, 사용자 조작과 API 응답 확인 |
| API E2E | k6 | 실제 배포 API | 인증, 세션, 대기열, 카탈로그, 감사·매출 API 계약 확인 |
| 배포 식별 | AWS CLI | CloudFront·GitOps | 테스트 결과가 어떤 배포 Revision을 검증했는지 기록 |
| 인프라 장애 주입 | Docker / kubectl | 로컬 Docker 또는 배포 EKS | 명시적으로 선택한 장애 주입·복구 확인 |

브라우저와 API 결과는 같은 실행 ID 아래 JSONL로 저장되며, 통합 판정은
`scripts/reporting/build-combined-summary.mjs`가 생성합니다. 공용 결과 계약은
[shared/result-schema.md](shared/result-schema.md)를 따릅니다.

## 빠른 시작

일반 사용자는 메뉴 실행기만 사용합니다.

```powershell
node scripts/gates/run-e2e-menu.mjs
```

1. 현재 사용자 PC의 AWS CLI 프로필 목록이 표시됩니다.
2. 사용할 프로필을 선택합니다. 목록은 `aws configure list-profiles`에서 읽으므로 사용자마다 다릅니다.
3. 테스트 메뉴를 선택합니다.

| 메뉴 | 실행 범위 | 영향 |
| --- | --- | --- |
| `1. 배포 필수 검증` | 필수 조회 + 인증·대기열·카탈로그·주문/결제 상태변경 검증 | 테스트 테넌트 DB에 이력·비활성 데이터가 남을 수 있음. EKS·AWS·Docker 리소스는 변경하지 않음 |
| `2. 인프라 조작 장애 주입 → 로컬 Docker` | `OPS-001`, `OPS-003` | 로컬 Docker 컨테이너를 중지·복구 |
| `2. 인프라 조작 장애 주입 → 배포 EKS` | `FE-BE-012`, `OPS-002`, `OPS-005` | EKS HPA, Deployment, Service selector, Pod를 실제 변경. `y/n` 재확인 필요 |

`erp-prod` 프로필이 있으면 메뉴에 권장 표시가 붙습니다. 배포 필수 검증은 프로젝트 AWS 계정과
CloudFront 조회 권한이 필요합니다. AWS SSO 세션이 만료됐다면 먼저 실행합니다.

```powershell
aws sso login --profile <profile-name>
```

## 실행 전제

- Node.js, AWS CLI, k6, Playwright Chromium이 설치되어 있어야 합니다.
- `.env.deploy-e2e.example`을 복사해 `.env.deploy-e2e.local`을 만들고, 배포 테스트 전용 계정을 설정합니다.
- `.env.deploy-e2e.local`과 AWS 자격증명·세션·토큰은 커밋하지 않습니다.
- 배포 필수 검증은 사전 점검에서 AWS 계정, 도구, 환경변수, CloudFront 배포 식별 정보를 확인합니다.
- EKS 장애 주입은 해당 클러스터의 `kubectl` Context와 필요한 RBAC 권한이 추가로 필요합니다.

## 인증 버킷 회복 대기

같은 테스트 계정의 로그인 요청은 Rate Limit Bucket을 공유합니다. 오탐 `429`를 피하기 위해 게이트는
단계 사이에 회복 대기를 둘 수 있습니다. 이때 테스트가 중단된 것이 아닙니다.

```text
⏳ [인증 버킷 회복 중] AUTH-001~004 이후 AUTH_VALID_01 버킷
   테스트는 중단되지 않았습니다. Rate Limit 오탐을 막기 위해 약 300초 대기합니다.
   다음 단계: SESS-001~003,006,007
   버킷 회복 중 · 남은 약 270초
```

약 30초마다 남은 시간이 출력되며, 회복이 끝나면 다음 단계가 자동으로 시작됩니다. 같은 테스트 계정을
쓰는 E2E 실행은 동시에 시작하지 마세요.

## 비대화형 실행

CI 또는 특정 단계 디버깅에만 사용합니다. 일반 사용자는 메뉴 실행기를 권장합니다.

```powershell
# AWS·도구·환경·배포 식별 정보만 점검
node scripts/gates/prepare-and-run-full-gate.mjs --aws-profile <profile-name> --preflight-only

# 상태변경을 포함하는 배포 필수 검증 (인프라 조작 없음)
node scripts/gates/prepare-and-run-required-gate.mjs --aws-profile <profile-name>

# 로컬 Docker 장애 주입
node scripts/gates/run-infrastructure-fault-injection.mjs --scope=local

# 배포 EKS 장애 주입 — 운영 영향이 있으므로 메뉴 사용을 권장
node scripts/gates/run-infrastructure-fault-injection.mjs --scope=eks --confirmed
```

## 결과 확인

각 실행은 `reports/<run-id>/`에 저장됩니다.

| 파일 | 용도 |
| --- | --- |
| `results.jsonl` | 브라우저 케이스별 정본 결과 |
| `<SUITE>.results.jsonl` | API 스위트별 정본 결과 |
| `summary.json`, `<SUITE>.summary.json` | 러너별 요약 |
| `combined-summary.json` | 브라우저·API·배포 식별 정보 통합 판정 |
| `report.md` | 사람이 읽기 쉬운 요약 |

`frontBackConnected`는 필수 기능 연결성의 좁은 판정입니다. `passConnected`는 브라우저 오류 없음,
배포 식별 정보, 요청 상관관계까지 포함한 엄격한 완료 판정입니다.

## 테스트가 증명하는 것

- 실제 배포 Origin에서 로그인, 세션 유지·무효화, 권한별 화면 접근이 동작한다.
- 브라우저 화면 조작이 실제 API 요청과 기대 응답으로 이어진다.
- 인증·세션·대기열·카탈로그·주문·결제·감사·매출의 대표 API 계약이 현재 배포에서 동작한다.
- 배포 필수 검증은 CloudFront와 GitOps Revision을 결과에 함께 기록한다.
- 선택한 인프라 장애 주입 범위에서는 장애 감지와 복구 흐름을 검증한다.

## 테스트가 증명하지 못하는 것

- 모든 화면·모든 역할·모든 예외 조합의 완전한 회귀 테스트가 아니다.
- 부하, 장시간 안정성, 비용, 보안 침투 테스트를 대체하지 않는다.
- 외부 결제의 실제 승인 완료 같은 제3자 시스템의 전체 거래를 보장하지 않는다.
- 배포 필수 검증만으로 EKS 리소스 변경·장애 복구를 증명하지 않는다. 이는 인프라 장애 주입을 명시적으로 실행해야 한다.
- DB에 남은 테스트 이력의 운영 적합성이나 데이터 정리 정책을 자동으로 판정하지 않는다.

## 관련 문서

- [LOCAL_REHEARSAL.md](LOCAL_REHEARSAL.md): 로컬 Docker Prod-like 리허설
- [api/README.md](api/README.md): k6 시나리오와 Rate Limit 상세
- [shared/result-schema.md](shared/result-schema.md): 결과 JSONL 계약
- `ERP/Docs/Specifications/운영·배포/배포 Frontend–Backend 종단 검증.md`: 검증 기준 원문
