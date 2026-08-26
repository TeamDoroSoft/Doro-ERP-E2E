import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, getJson, header, parseProblem } from '../lib/http.js'
import { record } from '../lib/resultLogger.js'

// AUDIT-001, SALES-001 (Tier A) — 배포 Frontend–Backend 종단 검증.md §10 확장 서비스 연결성 검증.
//
// 왜 이 둘을 한 파일에 합쳤는가: run-mandatory-gate.mjs의 AUTH_VALID_01 Rate Limit Bucket 예산은
// 이미 정확히 꽉 차 있다(용량 5 = session-flow.js 3회 + queue-connectivity.js 1회 +
// catalog-connectivity.js 1회 — run-mandatory-gate.mjs 82~84행 주석 참고). k6는 runK6Scenario가
// 시나리오 파일마다 별도 프로세스로 실행하므로 프로세스 간 Cookie Jar 공유가 불가능하다 — 즉 새
// 파일을 만들 때마다 그 파일 자신의 로그인이 최소 1회 필요하다. 파일을 2개(audit-connectivity.js,
// sales-connectivity.js)로 나누면 로그인 2회가 추가로 필요해 waitForAuthValid01BucketRefill()
// (5분 고정 대기)이 2번 붙지만, 파일 1개로 합치면 로그인 1회만 추가되어 5분 대기 1번으로 끝난다 —
// 그래서 실행 시간 비용을 최소화하려고 AUDIT-001/SALES-001이 로그인 1회를 공유하도록 합쳤다.
//
// AUDIT-001 — GET /api/v1/audits (Edge → audit-api). EdgeAuditController.java(edge-api)는
// from/to를 optional String으로만 받아 그대로 audit-api에 raw query string을 넘기지만, 실제 필수
// 검증은 AuditQueryService.validate()(audit-api)가 담당한다 — from/to가 없으면
// AuditQueryException.validation("from"/"to", "REQUIRED")로 400이다(AuditQueryService.java 확인
// 완료). 파싱은 AuditQueryController.java의 parseInstant()가 Instant.parse()로 하므로 반드시
// ISO-8601 Instant 포맷(예: "2026-08-26T05:00:00.000Z")이어야 한다 — JS Date.toISOString()이 그대로
// 맞는 포맷이라 별도 변환이 필요 없다. 최근 1시간 범위로 좁혀 쿼리스트링을 구성한다(MAX_RANGE=31일
// 제한과는 무관하게 넉넉히 안전한 폭).
// Role: AuditQueryService.authorizedActor()가 actorType=="EMPLOYEE" && (role=="OWNER" ||
// role=="MANAGER")만 통과시키고 STAFF를 포함한 그 외는 AuditQueryException.roleNotAllowed() →
// AuditQueryExceptionAdvice.java가 AUDIT_ROLE_NOT_ALLOWED(403 FORBIDDEN)로 매핑한다(확인 완료).
// AUTH_VALID_01이 실제로 OWNER인지는 로그인 응답 Body를 직접 읽어서 확인한다 —
// StoreAccessLoginForwarder.java(edge-api)가 store-access-api의 LoginResponse
// {employeeId, role, passwordChangeRequired}를 검증(3개 필드·role이 OWNER/MANAGER/STAFF 중 하나)만
// 하고 그대로 relay하므로, 이 러너가 파싱하는 로그인 응답 Body에 실제 role 문자열이 그대로 들어있다
// (확인 완료). status만으로 판정하면 "역할 불일치로 인한 403"과 "다른 원인의 403"을 구분할 수 없어,
// 실제 role 값을 읽어 로그(observed.accountRole)에 남기고 실패 시 errorClass에도 명시한다.
// 성공 조건: AuditQueryPage(items, nextCursor) record가 그대로 직렬화되므로, 데이터가 없어도
// {items:[], nextCursor:null}과 함께 200이다(AuditQueryPage.java/AuditQueryService.list() 확인 완료).
//
// SALES-001 — GET /api/v1/sales/daily?businessDate=<오늘> (Edge → commerce-api). 공개
// SalesController는 없다 — 실제 다운스트림은 HMAC 전용 EdgeSalesManagementController.java
// (commerce-api, /internal/v1/edge/sales/daily)다. Edge 쪽은 CommerceManagementRouteController.java
// 의 GET 매핑(/api/v1/sales/daily 포함)이 세션 쿠키를 확인한 뒤 CommerceManagementRouteForwarder로
// 그 내부 경로에 전달한다(GET이라 CSRF 검사도 건너뛴다 — XSRF-TOKEN 대조는 method!=GET일 때만,
// CommerceManagementRouteController.forward() 확인 완료). businessDate 계산은
// queue-connectivity.js가 이미 쓰는 STORE_UTC_OFFSET_MINUTES=9*60 고정 오프셋 로직을 그대로
// 재사용한다(아래 storeNow()/todayBusinessDate() — 그 파일과 동일한 계산, 별도 로직을 새로 만들지
// 않았다. k6는 시나리오 파일마다 별도 goja 프로세스라 모듈을 import로 공유해도 실행 비용상 이득이
// 없고, 기존 파일들도 각자 자기 완결적으로 상수를 복사해 쓰는 관례를 따른다).
// 자정 경계 리스크: SalesService.requireCurrentBusinessDate()(commerce-api)가 확인하는 건 "오픈
// 여부" 플래그가 아니라, store-access-api의 BusinessDateCalculator.currentBusinessDate()가
// 반환하는 "서버 현재 Instant를 매장 시간대로 변환한 LocalDate"다(clock.instant().atZone(zone)
// .toLocalDate() — DST 분기 없는 단순 변환, BusinessDateCalculator.java 확인 완료). 이 값과 Runner가
// 보낸 businessDate가 정확히 일치하지 않으면 SalesService.requireCurrentBusinessDate()가
// ResponseStatusException(HttpStatus.CONFLICT)를 던져 409가 된다(SalesService.java 확인 완료).
// Runner는 k6 goja 런타임의 Date.now()로 로컬 계산하고 서버는 자신의 Clock으로 계산하므로, 두 계산
// 시점이 KST 자정을 사이에 두고 갈라지면(레이턴시·시계 오차 포함) 하루가 어긋나 409가 날 수 있다 —
// 그래서 KST 자정 전후 KST_MIDNIGHT_SKIP_WINDOW_MINUTES(5)분 이내에는 이 케이스를 실패로 기록하지
// 않고 SKIP_PRECONDITION(사유: "자정 경계 근처 실행 회피")으로 건너뛴다(아래 isNearKstMidnight()).
// 성공 조건: 마감(Daily Closing) 레코드가 없어도 SalesReadPort.daily()가 실시간 집계로
// DailySalesView를 반환해 200이다(EdgeSalesManagementController.java/SalesService.daily() 확인
// 완료 — closing 레코드 존재를 요구하지 않음).
// Role: SalesService.employee()가 actor.canReadSales()만 확인하고, ActorContext.canReadSales()는
// actorType==EMPLOYEE만 보고 OWNER/MANAGER/STAFF를 구분하지 않는다(ActorContext.java 확인 완료) —
// AUDIT-001과 달리 Role 제한이 없다.
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

// queue-connectivity.js의 ALWAYS_ON_IDS와 같은 용도(로그인 실패 시 두 케이스 모두를
// SKIP_PRECONDITION으로 기록하기 위한 목록)다 — "MANDATORY"라는 이름을 쓰지 않는 이유는
// run-mandatory-gate.mjs가 SALES-001을 mandatoryApiCasesPassed 집계에서는 빼기 때문에(자정 경계
// SKIP 리스크, 이 파일 상단 주석 참고), 여기서 "MANDATORY_IDS"라고 부르면 "필수 게이트 판정용
// ID 목록"으로 오해될 수 있다.
const ALWAYS_ON_IDS = ['AUDIT-001', 'SALES-001']

// queue-connectivity.js의 STORE_UTC_OFFSET_MINUTES/todayBusinessDate()와 동일한 계산이다(그 파일
// 27~34행 주석 참고) — AUTH_VALID_01 소속 매장이 Asia/Seoul(UTC+9, DST 없음)이라는 같은 전제.
const STORE_UTC_OFFSET_MINUTES = 9 * 60
const KST_MIDNIGHT_SKIP_WINDOW_MINUTES = 5

function storeNow() {
  return new Date(Date.now() + STORE_UTC_OFFSET_MINUTES * 60 * 1000)
}

function todayBusinessDate() {
  return storeNow().toISOString().slice(0, 10)
}

// storeNow()가 반환하는 Date는 "UTC+9를 더한 벽시계 값"을 UTC 필드에 담아 표현한 것이므로,
// getUTCHours()/getUTCMinutes()를 그대로 매장 현지(KST) 시:분으로 읽을 수 있다(todayBusinessDate()
// 가 toISOString().slice(0,10)으로 날짜만 취하는 것과 같은 트릭). 자정 전후 정확히
// KST_MIDNIGHT_SKIP_WINDOW_MINUTES분 이내면 true를 반환한다.
function isNearKstMidnight() {
  const now = storeNow()
  const minutesSinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes()
  const minutesToNextMidnight = 24 * 60 - minutesSinceMidnight
  return (
    minutesSinceMidnight < KST_MIDNIGHT_SKIP_WINDOW_MINUTES ||
    minutesToNextMidnight <= KST_MIDNIGHT_SKIP_WINDOW_MINUTES
  )
}

export default function () {
  const env = loadDeployEnv()
  const loginUrl = `${env.apiOrigin}/api/v1/auth/login`
  const account = env.authValid01

  const jar = freshJar()
  const loginRes = postJson(
    loginUrl,
    { tenantCode: account.tenantCode, loginId: account.loginId, password: account.password },
    { jar },
  )
  if (loginRes.status !== 200) {
    const startedAt = new Date().toISOString()
    for (const id of ALWAYS_ON_IDS) {
      record(env, {
        testCaseId: id,
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_VALID_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: `사전 로그인 실패 (status=${loginRes.status}) — AUDIT-001/SALES-001 전제조건 불충족`,
      })
    }
    return
  }

  // 로그인 응답 Body(LoginResponse{employeeId,role,passwordChangeRequired})에서 role을 직접
  // 읽는다 — AUDIT-001 판정을 status만으로 하면 역할 불일치로 인한 403과 다른 원인의 403을
  // 구분할 수 없다(위 파일 상단 주석 참고).
  const loginBody = parseProblem(loginRes)
  const accountRole = loginBody.role || null

  group('AUDIT-001: Audit 목록 조회 (Edge → audit-api 라우팅 확인, from/to 필수)', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const to = new Date()
    const from = new Date(to.getTime() - 60 * 60 * 1000)
    const url =
      `${env.apiOrigin}/api/v1/audits` +
      `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
    const res = getJson(url, { jar })
    const pass = res.status === 200
    // OWNER/MANAGER가 아니면 AuditQueryService.authorizedActor()가 항상 403(AUDIT_ROLE_NOT_ALLOWED)
    // 을 던진다 — roleAllowed가 false인 채로 실패했다면 원인이 명확하도록 errorClass에 남긴다.
    const roleAllowed = accountRole === 'OWNER' || accountRole === 'MANAGER'
    check(null, { 'AUDIT-001 200': () => pass })
    record(env, {
      testCaseId: 'AUDIT-001',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: '/api/v1/audits', httpStatus: 200, requiredRole: 'OWNER 또는 MANAGER' },
      observed: { httpStatus: res.status, accountRole },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status200: pass, roleAllowed },
      errorClass: pass
        ? null
        : roleAllowed
          ? 'ASSERTION_MISMATCH'
          : `AUTH_VALID_01의 실제 role=${accountRole}이 OWNER/MANAGER가 아니라 ` +
            'AUDIT_ROLE_NOT_ALLOWED(403)로 거절됐을 가능성 — 계정 role 재확인 필요',
    })
  })

  group('SALES-001: 일별 매출 실시간 집계 조회 (Edge → commerce-api sales 라우팅 확인)', () => {
    const startedAt = new Date().toISOString()

    // KST 자정 전후에는 Runner와 서버의 businessDate 계산이 갈라져 실제 결함이 아닌 409가 날 수
    // 있다(위 파일 상단 주석 참고) — 실패로 기록하지 않고 스킵한다.
    if (isNearKstMidnight()) {
      record(env, {
        testCaseId: 'SALES-001',
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_VALID_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: '자정 경계 근처 실행 회피',
      })
      return
    }

    const t0 = Date.now()
    const businessDate = todayBusinessDate()
    const res = getJson(`${env.apiOrigin}/api/v1/sales/daily?businessDate=${businessDate}`, { jar })
    const pass = res.status === 200
    // SalesService.requireCurrentBusinessDate()는 commerce-api 자신의 로직이 아니라 내부적으로
    // store-access-api를 호출해(storeContexts.findCurrentContext()) 영업일을 확인한다 — 그 호출이
    // 실패하면 SERVICE_UNAVAILABLE(503)을 던진다(SalesService.java 확인 완료). 즉 SALES-001이
    // 503으로 실패하면 원인이 sales 라우팅 자체가 아니라 commerce-api→store-access-api 내부
    // 의존성일 가능성이 높다 — AUDIT-001의 role 불일치 힌트(위 참고)와 같은 이유로, 이 가능성을
    // errorClass에 명시해 나중에 원인 파악을 돕는다.
    const possibleStoreAccessDependencyFailure = res.status === 503
    check(null, { 'SALES-001 200': () => pass })
    record(env, {
      testCaseId: 'SALES-001',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { requestPath: '/api/v1/sales/daily', httpStatus: 200, businessDate },
      observed: { httpStatus: res.status, accountRole },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status200: pass },
      errorClass: pass
        ? null
        : possibleStoreAccessDependencyFailure
          ? 'commerce-api가 내부적으로 의존하는 store-access-api 연결 문제일 가능성(503) — ' +
            'sales 라우팅 자체보다 그쪽을 먼저 확인 필요'
          : 'ASSERTION_MISMATCH',
    })
  })
}

// handleSummary()는 일부러 두지 않는다 — 다른 api/scenarios/*.js와 같은 이유(resultLogger.js
// 주석 참고). summary.json/junit.xml은 `--log-format=raw` stdout을 api/lib/build-report.mjs로
// 후처리해서 만든다.
