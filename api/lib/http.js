import http from 'k6/http'

// 각 API 테스트는 독립 Cookie Jar를 쓴다. k6 기본은 VU 공용 Jar라서 케이스마다 새로 만든다.
export function freshJar() {
  return new http.CookieJar()
}

export function postJson(url, body, params = {}) {
  return http.post(url, JSON.stringify(body), {
    ...params,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, application/problem+json', ...(params.headers || {}) },
    redirects: 0,
  })
}

export function postRaw(url, rawBody, params = {}) {
  return http.post(url, rawBody, {
    ...params,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, application/problem+json', ...(params.headers || {}) },
    redirects: 0,
  })
}

export function getJson(url, params = {}) {
  return http.get(url, {
    ...params,
    headers: { Accept: 'application/json, application/problem+json', ...(params.headers || {}) },
    redirects: 0,
  })
}

export function patchJson(url, body, params = {}) {
  return http.patch(url, JSON.stringify(body), {
    ...params,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, application/problem+json', ...(params.headers || {}) },
    redirects: 0,
  })
}

// http.ts의 readCookie('XSRF-TOKEN')와 같은 역할 — 비Safe Method 요청에 X-XSRF-TOKEN Header로
// 실어 보낼 CSRF 토큰 값을 Cookie Jar에서 꺼낸다. k6 CookieJar.cookiesForURL()은 이름→값 배열
// 맵을 준다(속성 객체가 아니라 문자열 값만).
export function xsrfTokenFrom(jar, url) {
  const cookies = jar.cookiesForURL(url)
  const values = cookies['XSRF-TOKEN']
  return values && values.length > 0 ? values[0] : ''
}

export function header(res, name) {
  const target = name.toLowerCase()
  for (const key of Object.keys(res.headers || {})) {
    if (key.toLowerCase() === target) return res.headers[key]
  }
  return undefined
}

export function parseProblem(res) {
  try {
    return res.json()
  } catch {
    return {}
  }
}

// k6 `res.cookies['NAME'][0]`는 secure/http_only는 노출하지만 same_site는 노출하지 않는다
// (Grafana k6 문서 "Response Cookie Object Properties" 기준). SameSite는 원본 Set-Cookie 헤더
// 문자열에서 최선의 노력으로 파싱한다 — k6 버전에 따라 여러 Set-Cookie가 어떻게 병합되는지 달라질
// 수 있어 못 찾으면 null을 반환하고 호출부가 SKIP으로 표시한다.
export function cookieAttrs(res, name) {
  const list = res.cookies && res.cookies[name]
  if (!list || list.length === 0) return null
  const c = list[0]
  return {
    value: c.value,
    secure: c.secure,
    httpOnly: c.http_only,
    path: c.path,
    sameSite: sameSiteOf(res, name),
  }
}

function sameSiteOf(res, cookieName) {
  const raw = header(res, 'Set-Cookie')
  if (!raw) return null
  const parts = Array.isArray(raw) ? raw : String(raw).split(/,(?=[^;]+?=)/)
  const match = parts.find((part) => part.trim().toLowerCase().startsWith(`${cookieName.toLowerCase()}=`))
  if (!match) return null
  const m = /samesite=([a-z]+)/i.exec(match)
  return m ? m[1] : null
}
