import { check, group } from 'k6'
import { loadDeployEnv } from '../lib/env.js'
import { freshJar, postJson, getJson, patchJson, header, parseProblem, xsrfTokenFrom } from '../lib/http.js'
import { randomUuidV4 } from '../lib/provisioning.js'
import { record } from '../lib/resultLogger.js'

// CATALOG-001~003 (Tier A) — 배포 Frontend–Backend 종단 검증.md §10 확장 서비스 연결성 검증.
// 셋 다 AUTH_VALID_01(OWNER)의 SESSION Cookie만 있으면 되는 비파괴 조회다 — Role 제한 없음
// (EdgeCatalogController.java: SESSION XOR Kiosk Cookie만 확인 / CommerceManagementRouteController.java·
// CatalogService.java의 requireCatalogOperator(): OWNER/MANAGER/STAFF 모두 통과, ActorRole.canChangeSoldOut()
// 확인 완료). Entry가 하나도 없는 테넌트라도 loadManagedCategories()/loadManagedProducts()는 평범한
// SELECT라 빈 배열과 함께 200을 반환한다(QUEUE-001/002의 빈 목록 200과 동일한 이유 — 확인 완료).
//
// CATALOG-004~006 (Tier B) — 실제로 Category·Product를 생성·수정·품절 전환하는 상태 변경
// 흐름이라 RUN_DESTRUCTIVE_CATALOG_TESTS=true를 명시해야 실행된다(QUEUE-003과 같은 성격).
// [과거 결정 — 2026-08-26 폐기] CATALOG-001~003과 달리 AUTH_VALID_01이 아니라
// AUTH_ROLE_OWNER_01로 별도 로그인한다 — 둘 다
// OWNER Role이라 권한 문제는 아니고, AUTH_VALID_01의 테넌트(sample-store)는 실 데모 테넌트라
// 영구 Catalog 데이터를 남기고 싶지 않기 때문이다. AUTH_ROLE_OWNER_01의 테넌트(e2e-auth-active)는
// 실 고객이 0명인 합성 E2E 전용 테넌트라 Category·Product가 영구히 남아도 실 서비스에 영향이 없다
// (DB 직접 조회로 이번 세션에 확인 완료).
// [현재 결정 — 2026-08-26] 부트캠프 규모라 별도 계정을 새로 요청하지 않고, 이미 확보한
// AUTH_ROLE_OWNER_01(tenantCode=e2e-auth-active, loginId=e2e-role-owner)을 AUTH_VALID_01 역할까지
// 겸용한다. 두 별칭은 같은 물리 계정이며 서버측 계정 단위 Rate Limit Bucket도 공유한다.
// Category·Product 생성/수정은 CatalogService.java의
// requireCatalogManager() → ActorRole.canManageCatalog(): OWNER·MANAGER만 허용, STAFF는 거절
// (Category·Product 둘 다 같은 메서드를 거치는 것 확인 완료 — CatalogProductController.java
// Javadoc에 적힌 제약이 CatalogCategoryController.java에도 그대로 적용된다). DELETE Endpoint가
// 없어 생성한 자원은 영구히 남으므로, 매 실행마다 겹치지 않는 이름(randomUuidV4() 접두)으로
// 만들고 끝나면 반드시 `active:false`로 비활성화를 시도한다(QUEUE-003의 "항상 정리 시도" 철학과
// 동일 — verify-partial-pod-failure.mjs의 finally 기반 복구 패턴 참고). PATCH 계약은
// CatalogService.updateCategory()/updateProduct()를 직접 확인한 결과 요청 Body가
// UpdateCategoryCommand/UpdateProductCommand 전체 재기록이 아니라 **부분 업데이트**다 — 각 필드가
// `null`이면 그 필드는 바꾸지 않고 넘어간다(`if (command.name() != null) { ... }` 패턴). 그래서
// 비활성화 정리 호출은 `{active:false}`만 보내도 안전하다. Create/Update 응답 Body에는 ETag
// Header(`"<version>"`)뿐 아니라 JSON Body 자체에도 `version` 필드가 그대로 들어있다
// (CatalogViews.CategoryView/ProductView가 Java record라 Controller가 반환하는 Body 그대로
// 직렬화됨 — 확인 완료). `POST /api/v1/sales/daily/{date}/close`(영업일 마감)는 이 절의 대상이
// 아니다 — 되돌릴 Endpoint가 없는 회계 확정 동작이라 반복 실행 시 영업일을 영구히 잠그는 실제
// 위험이 있고, README.md "미구현 항목"의 A/B/C 분류(기존 항목과 중복/설계·인프라 제약/실행 비용)
// 중 어디에도 해당하지 않는 별도 사유(구현 난이도가 아니라 실행 자체의 위험)로 의도적으로
// 제외했다 — 자세한 내용은 배포 Frontend–Backend 종단 검증.md §10 참고.
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
}

const MANDATORY_IDS = ['CATALOG-001', 'CATALOG-002', 'CATALOG-003']
const DESTRUCTIVE_FLAG = 'RUN_DESTRUCTIVE_CATALOG_TESTS'
const TIER_B_IDS = ['CATALOG-004', 'CATALOG-005', 'CATALOG-006']

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
  } else {
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
        resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
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
        resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
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
        resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
        expected: { requestPath: '/api/v1/catalog/products', httpStatus: 200 },
        observed: { httpStatus: res.status },
        requestId: header(res, 'X-Request-Id'),
        assertions: { status200: pass },
        errorClass: pass ? null : 'ASSERTION_MISMATCH',
      })
    })
  }

  runTierBCatalogTests(env)
}

// CATALOG-004~006 (Tier B). AUTH_VALID_01 로그인 성공 여부와 무관하게 독립적으로 실행한다.
// [과거 결정 — 2026-08-26 폐기] Tier A와 Tier B는 서로 다른 계정(AUTH_VALID_01 vs
// AUTH_ROLE_OWNER_01)으로 로그인하므로 Tier A 로그인 실패가 Tier B를 막을 이유가 없었다.
// [현재 결정 — 2026-08-26] 두 별칭은 같은 물리 계정이지만, 각 Tier의 결과를 독립적으로 기록하는
// 기존 제어 흐름은 유지한다. 오케스트레이터는 두 로그인에 필요한 공유 Bucket 예산을 별도로 확보한다.
function runTierBCatalogTests(env) {
  if (__ENV[DESTRUCTIVE_FLAG] !== 'true') {
    const startedAt = new Date().toISOString()
    for (const id of TIER_B_IDS) {
      record(env, {
        testCaseId: id,
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_ROLE_OWNER_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: `${DESTRUCTIVE_FLAG}=true로 명시하지 않으면 실행하지 않음`,
      })
    }
    return
  }

  // [과거 결정 — 2026-08-26 폐기] AUTH_ROLE_OWNER_01 정적 계정 없이는 CATALOG-004~006을
  // 전용 격리 테넌트에서 실행할 방법이 없다고 판단했다.
  // [현재 결정 — 2026-08-26] AUTH_ROLE_OWNER_01은 AUTH_VALID_01과 같은 물리 계정이지만 Tier B가
  // 별도 환경변수 별칭을 계속 사용하므로 이 설정은 여전히 필요하다. Provisioning 폴백은 없다.
  // auth-lockout-ratelimit.js의
  // `if (!env.staticAccounts.lockout)` 패턴과 동일하게 처리한다.
  if (!env.staticAccounts.roleOwner) {
    const startedAt = new Date().toISOString()
    for (const id of TIER_B_IDS) {
      record(env, {
        testCaseId: id,
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_ROLE_OWNER_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: 'AUTH_ROLE_OWNER_01 정적 계정 설정 없음 — Tier B 로그인 별칭 준비 불가',
      })
    }
    return
  }

  const { tenantCode, loginId, password } = env.staticAccounts.roleOwner
  const loginUrl = `${env.apiOrigin}/api/v1/auth/login`
  const jar = freshJar()
  const loginRes = postJson(loginUrl, { tenantCode, loginId, password }, { jar })
  if (loginRes.status !== 200) {
    const startedAt = new Date().toISOString()
    for (const id of TIER_B_IDS) {
      record(env, {
        testCaseId: id,
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_ROLE_OWNER_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: `사전 로그인 실패 (status=${loginRes.status}) — CATALOG-004~006 전제조건 불충족`,
      })
    }
    return
  }

  const categoriesUrl = `${env.apiOrigin}/api/v1/catalog/categories`
  const productsUrl = `${env.apiOrigin}/api/v1/catalog/products`

  // 실측 확인(2026-08-27): catalog 도메인의 POST/PATCH는 CSRF 검증 대상이라(QUEUE-003의 POST와
  // 달리) X-XSRF-TOKEN 헤더 없이 보내면 애플리케이션 도달과 무관하게 항상 403
  // CSRF_VALIDATION_FAILED로 거절된다 — 실제로 curl로 직접 재현·확인 완료. 로그인 시 심어진
  // XSRF-TOKEN Cookie 값을 매 쓰기 요청마다 이 헬퍼로 꺼내 헤더에 실어 보낸다
  // (session-flow.js가 이미 쓰는 것과 같은 패턴).
  const csrfHeaders = (url) => ({ 'X-XSRF-TOKEN': xsrfTokenFrom(jar, url) })

  // CATALOG-005에서 만든 Product를 CATALOG-006이 이어받는다 — 두 그룹은 순서대로(동기) 실행되므로
  // CATALOG-005가 끝난(finally의 비활성화까지 포함) 시점의 최신 version이 여기 담긴다.
  let sharedProductId = null
  let sharedProductIfMatch = null

  group('CATALOG-004: Category 생성 → 목록 확인 → 수정 → 확인 → (정리) 비활성화', () => {
    const startedAt = new Date().toISOString()
    const t0 = Date.now()
    const categoryName = `E2E-CATALOG-CAT-${randomUuidV4().slice(0, 8)}`

    const createRes = postJson(
      categoriesUrl,
      { name: categoryName, displayOrder: 1, active: true },
      { jar, headers: csrfHeaders(categoriesUrl) },
    )
    const createBody = parseProblem(createRes)
    const categoryId = createBody.categoryId
    const created = createRes.status === 201 && !!categoryId
    let ifMatch = created ? header(createRes, 'ETag') || `"${createBody.version}"` : null

    let listedAfterCreate = false
    let updateStatus = null
    let updateOk = false
    let updatedName = null
    let updatedDisplayOrder = null
    let deactivateStatus = null
    let deactivatedOk = false

    try {
      if (created) {
        const listRes = getJson(categoriesUrl, { jar })
        const listBody = parseProblem(listRes)
        listedAfterCreate =
          listRes.status === 200 &&
          Array.isArray(listBody) &&
          listBody.some((c) => c.categoryId === categoryId && c.name === categoryName)

        const updatedNameCandidate = `${categoryName}-UPD`
        const updateRes = patchJson(
          `${categoriesUrl}/${categoryId}`,
          { name: updatedNameCandidate, displayOrder: 2, active: true },
          { jar, headers: { 'If-Match': ifMatch, ...csrfHeaders(`${categoriesUrl}/${categoryId}`) } },
        )
        const updateBody = parseProblem(updateRes)
        updateStatus = updateRes.status
        updatedName = updateBody.name
        updatedDisplayOrder = updateBody.displayOrder
        updateOk =
          updateRes.status === 200 && updateBody.name === updatedNameCandidate && updateBody.displayOrder === 2
        if (updateRes.status === 200) {
          ifMatch = header(updateRes, 'ETag') || `"${updateBody.version}"`
        }
      }
    } finally {
      // 목록·수정 단언이 실패해도 생성된 Category가 활성 상태로 방치되지 않도록, 생성이 됐다면
      // 비활성화는 반드시 시도한다(QUEUE-003 finally 패턴과 동일).
      if (created) {
        const deactivateRes = patchJson(
          `${categoriesUrl}/${categoryId}`,
          { active: false },
          { jar, headers: { 'If-Match': ifMatch, ...csrfHeaders(`${categoriesUrl}/${categoryId}`) } },
        )
        const deactivateBody = parseProblem(deactivateRes)
        deactivateStatus = deactivateRes.status
        deactivatedOk = deactivateRes.status === 200 && deactivateBody.active === false
      }
    }

    const pass = created && listedAfterCreate && updateOk && deactivatedOk
    check(null, { 'CATALOG-004 Category 생성→목록→수정→비활성화': () => pass })
    record(env, {
      testCaseId: 'CATALOG-004',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_ROLE_OWNER_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { createHttpStatus: 201, updateHttpStatus: 200, deactivateHttpStatus: 200 },
      observed: {
        createHttpStatus: createRes.status,
        categoryId: categoryId || null,
        updateHttpStatus: updateStatus,
        updatedName,
        updatedDisplayOrder,
        deactivateHttpStatus: deactivateStatus,
      },
      requestId: header(createRes, 'X-Request-Id'),
      assertions: { created, listedAfterCreate, updateOk, deactivatedOk },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })

  group(
    'CATALOG-005: 전용 Category 생성 → Product 생성 → 목록 확인 → 수정 → 확인 → (정리) 상품·Category 비활성화',
    () => {
      const startedAt = new Date().toISOString()
      const t0 = Date.now()

      // CATALOG-004의 Category를 재사용하지 않고 이 케이스 전용 Category를 새로 만든다 —
      // CATALOG-004가 실패(생성 실패·단언 실패 등)해도 CATALOG-005가 그 실패와 무관하게 독립
      // 실행·판정되도록 분리하기 위해서다(하나가 FAIL이어도 다른 하나의 원인 분리가 쉬워진다).
      const dedicatedCategoryName = `E2E-CATALOG-CAT-FOR-PRODUCT-${randomUuidV4().slice(0, 8)}`
      const categoryCreateRes = postJson(
        categoriesUrl,
        { name: dedicatedCategoryName, displayOrder: 1, active: true },
        { jar, headers: csrfHeaders(categoriesUrl) },
      )
      const categoryCreateBody = parseProblem(categoryCreateRes)
      const dedicatedCategoryId = categoryCreateBody.categoryId
      const categoryCreated = categoryCreateRes.status === 201 && !!dedicatedCategoryId
      let categoryIfMatch = categoryCreated
        ? header(categoryCreateRes, 'ETag') || `"${categoryCreateBody.version}"`
        : null

      if (!categoryCreated) {
        record(env, {
          testCaseId: 'CATALOG-005',
          startedAt,
          durationMs: Date.now() - t0,
          accountAlias: 'AUTH_ROLE_OWNER_01',
          resultCode: 'SKIP_PRECONDITION',
          errorClass: `전용 Category 생성 실패 (status=${categoryCreateRes.status}) — CATALOG-005 전제조건 불충족`,
        })
        return
      }

      const productName = `E2E-CATALOG-PROD-${randomUuidV4().slice(0, 8)}`
      const createRes = postJson(
        productsUrl,
        {
          categoryId: dedicatedCategoryId,
          name: productName,
          description: 'doro-erp-e2e CATALOG-005 자동 생성 — 실행마다 새 이름으로 생성됨',
          price: 1000,
          displayOrder: 1,
          active: true,
        },
        { jar, headers: csrfHeaders(productsUrl) },
      )
      const createBody = parseProblem(createRes)
      const productId = createBody.productId
      const created = createRes.status === 201 && !!productId
      let ifMatch = created ? header(createRes, 'ETag') || `"${createBody.version}"` : null

      let listedAfterCreate = false
      let updateStatus = null
      let updateOk = false
      let updatedName = null
      let updatedPrice = null
      let productDeactivateStatus = null
      let productDeactivatedOk = false
      let categoryDeactivateStatus = null
      let categoryDeactivatedOk = false

      try {
        if (created) {
          const listRes = getJson(productsUrl, { jar })
          const listBody = parseProblem(listRes)
          listedAfterCreate =
            listRes.status === 200 &&
            Array.isArray(listBody) &&
            listBody.some((p) => p.productId === productId && p.name === productName)

          const updatedNameCandidate = `${productName}-UPD`
          const updateRes = patchJson(
            `${productsUrl}/${productId}`,
            { name: updatedNameCandidate, price: 2000, displayOrder: 2, active: true },
            { jar, headers: { 'If-Match': ifMatch, ...csrfHeaders(`${productsUrl}/${productId}`) } },
          )
          const updateBody = parseProblem(updateRes)
          updateStatus = updateRes.status
          updatedName = updateBody.name
          updatedPrice = updateBody.price
          updateOk =
            updateRes.status === 200 && updateBody.name === updatedNameCandidate && updateBody.price === 2000
          if (updateRes.status === 200) {
            ifMatch = header(updateRes, 'ETag') || `"${updateBody.version}"`
          }
        }
      } finally {
        // CATALOG-004와 같은 이유로, 목록·수정 단언 결과와 무관하게 생성됐다면 상품 비활성화는
        // 반드시 시도한다. 전용 Category도 이 케이스가 만든 것이므로 같은 finally에서 함께
        // 비활성화한다(상품 비활성화 성공 여부와 무관하게 시도 — 두 자원 다 방치하지 않는다).
        if (created) {
          const deactivateRes = patchJson(
            `${productsUrl}/${productId}`,
            { active: false },
            { jar, headers: { 'If-Match': ifMatch, ...csrfHeaders(`${productsUrl}/${productId}`) } },
          )
          const deactivateBody = parseProblem(deactivateRes)
          productDeactivateStatus = deactivateRes.status
          productDeactivatedOk = deactivateRes.status === 200 && deactivateBody.active === false
          if (deactivateRes.status === 200) {
            ifMatch = header(deactivateRes, 'ETag') || `"${deactivateBody.version}"`
            sharedProductId = productId
            sharedProductIfMatch = ifMatch
          }
        }
        const categoryDeactivateRes = patchJson(
          `${categoriesUrl}/${dedicatedCategoryId}`,
          { active: false },
          { jar, headers: { 'If-Match': categoryIfMatch, ...csrfHeaders(`${categoriesUrl}/${dedicatedCategoryId}`) } },
        )
        const categoryDeactivateBody = parseProblem(categoryDeactivateRes)
        categoryDeactivateStatus = categoryDeactivateRes.status
        categoryDeactivatedOk = categoryDeactivateRes.status === 200 && categoryDeactivateBody.active === false
      }

      const pass = created && listedAfterCreate && updateOk && productDeactivatedOk && categoryDeactivatedOk
      check(null, { 'CATALOG-005 Product 생성→목록→수정→비활성화(+Category 비활성화)': () => pass })
      record(env, {
        testCaseId: 'CATALOG-005',
        startedAt,
        durationMs: Date.now() - t0,
        accountAlias: 'AUTH_ROLE_OWNER_01',
        resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
        expected: {
          createHttpStatus: 201,
          updateHttpStatus: 200,
          productDeactivateHttpStatus: 200,
          categoryDeactivateHttpStatus: 200,
        },
        observed: {
          categoryId: dedicatedCategoryId,
          createHttpStatus: createRes.status,
          productId: productId || null,
          updateHttpStatus: updateStatus,
          updatedName,
          updatedPrice,
          productDeactivateHttpStatus: productDeactivateStatus,
          categoryDeactivateHttpStatus: categoryDeactivateStatus,
        },
        requestId: header(createRes, 'X-Request-Id'),
        assertions: { created, listedAfterCreate, updateOk, productDeactivatedOk, categoryDeactivatedOk },
        errorClass: pass ? null : 'ASSERTION_MISMATCH',
      })
    },
  )

  group('CATALOG-006: 품절 전환 → 확인 → 복구 → 확인 (완전 가역)', () => {
    const startedAt = new Date().toISOString()

    // CATALOG-005가 상품을 만들지 못했다면(생성 실패로 SKIP됐거나 비활성화까지 실패해 version을
    // 못 구했다면) 이어받을 상품이 없어 전제조건 불충족이다.
    if (!sharedProductId) {
      record(env, {
        testCaseId: 'CATALOG-006',
        startedAt,
        durationMs: 0,
        accountAlias: 'AUTH_ROLE_OWNER_01',
        resultCode: 'SKIP_PRECONDITION',
        errorClass: 'CATALOG-005 상품 생성/정리 실패로 전제조건 불충족',
      })
      return
    }

    const t0 = Date.now()
    const soldOutUrl = `${env.apiOrigin}/api/v1/catalog/products/${sharedProductId}/sold-out`
    let ifMatch = sharedProductIfMatch

    const toTrueRes = patchJson(
      soldOutUrl,
      { soldOut: true },
      { jar, headers: { 'If-Match': ifMatch, ...csrfHeaders(soldOutUrl) } },
    )
    const toTrueBody = parseProblem(toTrueRes)
    const toTrueOk = toTrueRes.status === 200 && toTrueBody.soldOut === true
    if (toTrueRes.status === 200) {
      ifMatch = header(toTrueRes, 'ETag') || `"${toTrueBody.version}"`
    }

    const toFalseRes = patchJson(
      soldOutUrl,
      { soldOut: false },
      { jar, headers: { 'If-Match': ifMatch, ...csrfHeaders(soldOutUrl) } },
    )
    const toFalseBody = parseProblem(toFalseRes)
    const toFalseOk = toFalseRes.status === 200 && toFalseBody.soldOut === false

    const pass = toTrueOk && toFalseOk
    check(null, { 'CATALOG-006 품절 true→false 왕복': () => pass })
    record(env, {
      testCaseId: 'CATALOG-006',
      startedAt,
      durationMs: Date.now() - t0,
      accountAlias: 'AUTH_ROLE_OWNER_01',
      resultCode: pass ? 'PASS' : 'FAIL_ASSERTION',
      expected: { toTrueHttpStatus: 200, toFalseHttpStatus: 200 },
      observed: {
        productId: sharedProductId,
        toTrueHttpStatus: toTrueRes.status,
        toTrueSoldOut: toTrueBody.soldOut,
        toFalseHttpStatus: toFalseRes.status,
        toFalseSoldOut: toFalseBody.soldOut,
      },
      requestId: header(toTrueRes, 'X-Request-Id'),
      assertions: { toTrueOk, toFalseOk },
      errorClass: pass ? null : 'ASSERTION_MISMATCH',
    })
  })
}

// handleSummary()는 일부러 두지 않는다 — 다른 api/scenarios/*.js와 같은 이유(resultLogger.js
// 주석 참고). summary.json/junit.xml은 `--log-format=raw` stdout을 api/lib/build-report.mjs로
// 후처리해서 만든다.
