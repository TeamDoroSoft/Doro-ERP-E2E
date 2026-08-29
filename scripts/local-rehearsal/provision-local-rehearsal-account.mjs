#!/usr/bin/env node
// 로컬 Docker Prod-like 리허설 전용 스크립트. 실제 dev/stage/prod 테넌트에는 손대지 않는다 —
// 여기서 만드는 계정은 로컬 Postgres(Doro-ERP-Service/environments/local)에만 존재한다.
//
// 이 리허설 스택은 자체 서명 TLS라 Node의 기본 인증서 검증을 통과하지 못한다. 이 프로세스
// 안에서만 검증을 끈다 — 실제 dev/stage/prod Origin을 대상으로는 절대 이 값을 쓰지 않는다.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const stateFile = resolve(here, '..', '..', '.env.local-rehearsal.local')

const PROVISIONING_ORIGIN = process.env.PROVISIONING_ORIGIN ?? 'https://localhost:8081'
const EDGE_ORIGIN = process.env.EDGE_ORIGIN ?? 'https://localhost:8080'
const PROVISIONING_USERNAME = requireEnv('STORE_ACCESS_PROVISIONING_USERNAME')
const PROVISIONING_PASSWORD = requireEnv('STORE_ACCESS_PROVISIONING_PASSWORD')

function requireEnv(name) {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    console.error(
      `${name} 환경변수가 없습니다. Doro-ERP-Service/.env에 이미 채워둔 값을 그대로 export해서 실행하세요 ` +
        '(docker-compose.apps.yml이 같은 .env를 읽으므로 두 값이 항상 일치해야 한다).',
    )
    process.exit(2)
  }
  return value
}

function randomToken(byteLength) {
  return randomBytes(byteLength).toString('base64url')
}

// PasswordPolicyValidator.MIN_LENGTH = 15. 블록리스트/서비스 파생어 회피를 위해 무작위 토큰을
// 쓴다 — 사람이 고른 문구보다 우연히 블록리스트에 걸릴 확률이 낮다.
function randomPassword() {
  return `Rehearsal-${randomToken(16)}`
}

function loadOrCreateCredentials() {
  if (existsSync(stateFile)) {
    const parsed = Object.fromEntries(
      readFileSync(stateFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const idx = line.indexOf('=')
          return [line.slice(0, idx), line.slice(idx + 1)]
        }),
    )
    if (
      parsed.DORO_AUTH_VALID_01_TENANT_CODE &&
      parsed.DORO_AUTH_VALID_01_LOGIN_ID &&
      parsed.DORO_AUTH_VALID_01_PASSWORD &&
      parsed.__REHEARSAL_TEMP_PASSWORD
    ) {
      console.log(`기존 리허설 계정 정보를 재사용합니다: ${stateFile}`)
      return {
        fromState: true,
        tenantCode: parsed.DORO_AUTH_VALID_01_TENANT_CODE,
        loginId: parsed.DORO_AUTH_VALID_01_LOGIN_ID,
        permanentPassword: parsed.DORO_AUTH_VALID_01_PASSWORD,
        tempPassword: parsed.__REHEARSAL_TEMP_PASSWORD,
        tenantName: 'Doro E2E Rehearsal',
        storeName: 'Doro E2E Rehearsal Store',
      }
    }
  }

  console.log('리허설 계정 정보가 없어 새로 생성합니다.')
  return {
    fromState: false,
    tenantCode: `e2e-rehearsal-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    loginId: 'owner',
    tenantName: 'Doro E2E Rehearsal',
    storeName: 'Doro E2E Rehearsal Store',
    tempPassword: randomPassword(),
    permanentPassword: randomPassword(),
  }
}

function writeState(creds) {
  mkdirSync(dirname(stateFile), { recursive: true })
  const content = [
    '# 로컬 Docker Prod-like 리허설 전용 — 커밋 금지 (.gitignore의 .env.*.local 패턴에 걸림)',
    '# doro-erp-e2e/README.md "로컬 Docker Prod-like 리허설 모드" 참고',
    `DORO_ENVIRONMENT=local-prod-like`,
    `DORO_AUTH_VALID_01_TENANT_CODE=${creds.tenantCode}`,
    `DORO_AUTH_VALID_01_LOGIN_ID=${creds.loginId}`,
    `DORO_AUTH_VALID_01_PASSWORD=${creds.permanentPassword}`,
    `__REHEARSAL_TEMP_PASSWORD=${creds.tempPassword}`,
    '',
  ].join('\n')
  writeFileSync(stateFile, content, { mode: 0o600 })
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${PROVISIONING_USERNAME}:${PROVISIONING_PASSWORD}`).toString('base64')}`
}

async function provisionTenant(creds) {
  const res = await fetch(`${PROVISIONING_ORIGIN}/internal/v1/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader() },
    body: JSON.stringify({
      tenantCode: creds.tenantCode,
      tenantName: creds.tenantName,
      storeName: creds.storeName,
    }),
  })
  if (res.status !== 200) {
    throw new Error(`테넌트 Provisioning 실패: HTTP ${res.status} — ${await safeText(res)}`)
  }
  const body = await res.json()
  console.log(`테넌트 준비 완료: tenantId=${body.tenantId} tenantCode=${body.tenantCode}`)
  return body.tenantId
}

async function provisionOwner(tenantId, creds) {
  const res = await fetch(`${PROVISIONING_ORIGIN}/internal/v1/tenants/${tenantId}/first-owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader() },
    body: JSON.stringify({ loginId: creds.loginId, temporaryPassword: creds.tempPassword }),
  })
  if (res.status === 200) {
    console.log('최초 OWNER 준비 완료 (신규 생성 또는 동일 요청 재생).')
    return
  }
  if (res.status === 409) {
    // 이전 실행에서 이미 비밀번호를 영구 비밀번호로 바꿔뒀다면, 이 호출이 쓰는 tempPassword가
    // 더 이상 저장된 Hash와 일치하지 않아 409가 난다 — 정상적인 재실행 시나리오라 무시하고
    // 아래 로그인 검증 단계에서 실제 상태를 확인한다.
    console.log('최초 OWNER가 이미 다른 상태로 존재합니다 (409) — 로그인 검증 단계에서 실제 상태를 확인합니다.')
    return
  }
  throw new Error(`최초 OWNER Provisioning 실패: HTTP ${res.status} — ${await safeText(res)}`)
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return '(no body)'
  }
}

function parseCookies(res) {
  const jar = {}
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const idx = pair.indexOf('=')
    jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return jar
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

async function login(tenantCode, loginId, password) {
  const res = await fetch(`${EDGE_ORIGIN}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantCode, loginId, password }),
  })
  if (res.status !== 200) return { ok: false, status: res.status }
  const body = await res.json()
  return { ok: true, cookies: parseCookies(res), passwordChangeRequired: body.passwordChangeRequired }
}

async function changePassword(jar, currentPassword, newPassword) {
  const res = await fetch(`${EDGE_ORIGIN}/api/v1/employees/me/password`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      'X-XSRF-TOKEN': jar['XSRF-TOKEN'] ?? '',
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (res.status !== 200) {
    throw new Error(`비밀번호 변경 실패: HTTP ${res.status} — ${await safeText(res)}`)
  }
}

// 계정 Rate Limit Bucket(계정당 용량 5, 분당 1 보충)은 이 스크립트가 소모한 만큼 그대로
// doro-erp-e2e 실행에서 쓸 수 있는 몫이 줄어든다 — 로그인 시도는 성공·실패 관계없이 전부
// Bucket을 소비한다(비밀번호 검증 전에 차감). 그래서 확실히 알 수 있는 경우엔 확인용 로그인을
// 아예 생략한다: 방금 새로 만든 계정은 아직 임시 비밀번호 상태인 게 확실하므로 "영구 비밀번호로
// 먼저 시도"하는 탐색적 로그인을 건너뛰고, 비밀번호 변경 성공(PATCH 200)을 그대로 신뢰해
// 변경 후 재로그인 검증도 생략한다. 기존 상태 파일을 재사용하는 경우에만(계정이 이미
// 어떤 상태인지 모르므로) 최소한의 탐색 로그인을 한다.
async function main() {
  const creds = loadOrCreateCredentials()

  const tenantId = await provisionTenant(creds)
  await provisionOwner(tenantId, creds)

  if (!creds.fromState) {
    console.log('신규 계정 — 임시 비밀번호로 로그인 후 영구 비밀번호로 변경합니다 (Rate Limit 토큰 1개 사용)...')
    const withTemp = await login(creds.tenantCode, creds.loginId, creds.tempPassword)
    if (!withTemp.ok || !withTemp.passwordChangeRequired) {
      throw new Error(
        `신규 계정의 임시 비밀번호 로그인이 예상과 다릅니다 (ok=${withTemp.ok}, ` +
          `passwordChangeRequired=${withTemp.passwordChangeRequired}, status=${withTemp.status}).`,
      )
    }
    await changePassword(withTemp.cookies, creds.tempPassword, creds.permanentPassword)
    console.log('영구 비밀번호로 변경 완료 (재검증 로그인은 Rate Limit 토큰 절약을 위해 생략).')
    writeState(creds)
    printSummary(creds)
    return
  }

  console.log('기존 계정 — 영구 비밀번호로 먼저 시도합니다 (Rate Limit 토큰 1개 사용)...')
  const withPermanent = await login(creds.tenantCode, creds.loginId, creds.permanentPassword)
  if (withPermanent.ok && !withPermanent.passwordChangeRequired) {
    console.log('이미 영구 비밀번호로 로그인 가능한 상태입니다 — 추가 작업 없음.')
    writeState(creds)
    printSummary(creds)
    return
  }

  console.log('영구 비밀번호로 실패 — 임시 비밀번호로 재시도합니다 (Rate Limit 토큰 1개 추가 사용)...')
  const withTemp = await login(creds.tenantCode, creds.loginId, creds.tempPassword)
  if (!withTemp.ok) {
    throw new Error(
      '영구 비밀번호와 임시 비밀번호 둘 다 로그인에 실패했습니다. .env.local-rehearsal.local을 지우고 ' +
        '다시 실행하거나, 로컬 Postgres 상태를 직접 확인하세요. (계정 Rate Limit 소진일 수도 있음 — ' +
        '분당 1개씩 보충되니 잠시 후 재시도)',
    )
  }
  if (!withTemp.passwordChangeRequired) {
    throw new Error('예상치 못한 계정 상태입니다: 임시 비밀번호로 로그인됐지만 passwordChangeRequired=false.')
  }
  await changePassword(withTemp.cookies, creds.tempPassword, creds.permanentPassword)
  console.log('영구 비밀번호로 변경 완료 (재검증 로그인은 Rate Limit 토큰 절약을 위해 생략).')

  writeState(creds)
  printSummary(creds)
}

function printSummary(creds) {
  console.log('')
  console.log(`tenantCode: ${creds.tenantCode}`)
  console.log(`loginId:    ${creds.loginId}`)
  console.log(`저장 위치:   ${stateFile} (비밀번호는 여기 파일에만 있고, 터미널에는 출력하지 않음)`)
  console.log('')
  console.log('doro-erp-e2e 실행 시 다음처럼 불러와 쓰세요 (bash):')
  console.log(`  set -a; source ${stateFile}; set +a`)
  console.log('')
  console.log(
    '이 스크립트가 방금 계정 Rate Limit 토큰을 1개 썼습니다(용량 5, 분당 1 보충). FE-BE-002~006 ' +
      '풀 스위트는 로그인 5회가 필요하니, 바로 이어서 돌리면 마지막 케이스가 429로 막힐 수 있습니다 — ' +
      '약 1분만 기다렸다가 실행하세요.',
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
