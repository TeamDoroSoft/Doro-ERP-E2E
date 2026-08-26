import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, getJson, header } from '../lib/http.js'
import { record } from '../lib/resultLogger.js'

// CATALOG-001~003 (Tier A) — 배포 Frontend–Backend 종단 검증.md §10 확장 서비스 연결성 검증.
// 셋 다 AUTH_VALID_01(OWNER)의 SESSION Cookie만 있으면 되는 비파괴 조회다 — Role 제한 없음
// (EdgeCatalogController.java: SESSION XOR Kiosk Cookie만 확인 / CommerceManagementRouteController.java·
// CatalogService.java의 requireCatalogOperator(): OWNER/MANAGER/STAFF 모두 통과, ActorRole.canChangeSoldOut()
// 확인 완료). Entry가 하나도 없는 테넌트라도 loadManagedCategories()/loadManagedProducts()는 평범한
// SELECT라 빈 배열과 함께 200을 반환한다(QUEUE-001/002의 빈 목록 200과 동일한 이유 — 확인 완료).
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

const MANDATORY_IDS = ['CATALOG-001', 'CATALOG-002', 'CATALOG-003']

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
    for (const id of MANDATORY_IDS) {
      record(env, {
        testCaseId: id,
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_VALID_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: `사전 로그인 실패 (status=${loginRes.status}) — CATALOG-* 전제조건 불충족`,
      })
    }
    return
  }

  group('CATALOG-001: 판매 메뉴 조회 (Edge → commerce-api 라우팅 확인)', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = getJson(`${env.apiOrigin}/api/v1/catalog/menu`, { jar })
    const pass = res.status === 200
    check(null, { 'CATALOG-001 200': () => pass })
    record(env, {
      testCaseId: 'CATALOG-001',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_PROTECTED_FLOW',
      expected: { requestPath: '/api/v1/catalog/menu', httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status200: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('CATALOG-002: Category 관리 목록 조회', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = getJson(`${env.apiOrigin}/api/v1/catalog/categories`, { jar })
    const pass = res.status === 200
    check(null, { 'CATALOG-002 200': () => pass })
    record(env, {
      testCaseId: 'CATALOG-002',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_PROTECTED_FLOW',
      expected: { requestPath: '/api/v1/catalog/categories', httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status200: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group('CATALOG-003: Product 관리 목록 조회', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const res = getJson(`${env.apiOrigin}/api/v1/catalog/products`, { jar })
    const pass = res.status === 200
    check(null, { 'CATALOG-003 200': () => pass })
    record(env, {
      testCaseId: 'CATALOG-003',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_VALID_01',
      resultCode: pass ? 'PASS' : 'FAIL_PROTECTED_FLOW',
      expected: { requestPath: '/api/v1/catalog/products', httpStatus: 200 },
      observed: { httpStatus: res.status },
      requestId: header(res, 'X-Request-Id'),
      assertions: { status200: pass },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })
}

// handleSummary()는 일부러 두지 않는다 — 다른 api/scenarios/*.js와 같은 이유(resultLogger.js
// 주석 참고). summary.json/junit.xml은 `--log-format=raw` stdout을 api/lib/build-report.mjs로
// 후처리해서 만든다.
