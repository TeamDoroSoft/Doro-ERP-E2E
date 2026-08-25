#!/usr/bin/env node
// 보고서 §7.3 `deployment` 4개 필드(frontendRevision/cloudFrontDistributionId/edgeRevision/
// storeAccessRevision)를 실제 AWS·GitOps에서 읽어와 .env.deployment-identity.local에 쓴다.
//
// 이 스크립트는 자격증명을 저장하거나 관리하지 않는다 — AWS CLI가 이미 구성된 자격증명 체인
// (환경변수/AWS_PROFILE/SSO 세션 등)을 그대로 쓰게 둔다. Doro-ERP-Infra/bootstrap/README.md의
// `$env:AWS_PROFILE = "erp-prod"` 관례를 그대로 따른다고 가정하며, 이 저장소 안에는 Access
// Key·Secret·Session Token을 절대 두지 않는다.
//
//   frontendRevision          — CloudFront Origin S3 버킷의 index.html ETag (AWS API)
//   cloudFrontDistributionId  — Alias(도메인)로 찾은 CloudFront Distribution Id (AWS API)
//   edgeRevision/             — Doro-ERP-GitOps의 kustomization.yaml images[] 블록을 그대로
//   storeAccessRevision         읽는다(파일 읽기만, AWS 호출 없음) — "sha256:unconfigured"면
//                                아직 이 서비스가 GitOps로 릴리스된 적이 없다는 뜻이라 "unknown"으로
//                                정규화한다.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = resolve(repoRoot, '.env.deployment-identity.local')

const FRONTEND_DOMAIN = process.env.DORO_FRONTEND_DOMAIN || 'doro.minseok.click'
const GITOPS_KUSTOMIZATION =
  process.env.GITOPS_KUSTOMIZATION_PATH ||
  resolve(repoRoot, '..', 'Doro-ERP-GitOps', 'deploy', 'overlays', 'prod', 'alpha', 'kustomization.yaml')

const UNCONFIGURED_MARKERS = new Set(['unconfigured', 'sha256:unconfigured'])

function aws(args) {
  return execFileSync('aws', args, { encoding: 'utf8' }).trim()
}

function checkCredentials() {
  try {
    const identity = JSON.parse(aws(['sts', 'get-caller-identity', '--output', 'json']))
    console.log(`AWS 자격증명 확인됨: Account=${identity.Account} Arn=${identity.Arn}`)
    return identity
  } catch (error) {
    throw new Error(
      'AWS 자격증명을 확인할 수 없습니다 (ERROR_CONFIG). AWS_PROFILE을 설정했는지, aws sso login을 ' +
        '했는지 확인하세요 — 예: $env:AWS_PROFILE="erp-prod" (Doro-ERP-Infra/bootstrap/README.md 관례). ' +
        `원본 오류: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function resolveCloudFront(domain) {
  // Aliases.Quantity가 0인 Distribution은 Aliases.Items가 빈 배열이 아니라 null이라, contains()에
  // null을 그대로 넘기면 AWS CLI가 타입 오류를 낸다(실제로 재현·확인함) — `|| \`[]\``로 null을
  // 빈 배열로 바꿔준다.
  const query =
    `DistributionList.Items[?contains(Aliases.Items || \`[]\`, '${domain}')].` +
    `{Id:Id,OriginDomain:Origins.Items[0].DomainName}`
  const raw = aws(['cloudfront', 'list-distributions', '--query', query, '--output', 'json'])
  const matches = JSON.parse(raw)
  if (matches.length === 0) {
    throw new Error(`CloudFront Distribution 중 Alias에 '${domain}'을 포함한 게 없습니다.`)
  }
  if (matches.length > 1) {
    throw new Error(
      `CloudFront Distribution이 '${domain}' Alias로 ${matches.length}개 잡혔습니다 — 하나로 ` +
        `좁혀야 합니다: ${JSON.stringify(matches)}`,
    )
  }
  return matches[0] // { Id, OriginDomain }
}

function resolveFrontendRevision(originDomain) {
  // CloudFront S3 Origin의 DomainName은 보통 "<bucket>.s3.<region>.amazonaws.com" 형태다.
  const bucket = originDomain.split('.s3')[0]
  if (!bucket || bucket === originDomain) {
    throw new Error(`CloudFront Origin Domain에서 S3 버킷 이름을 못 뽑았습니다: ${originDomain}`)
  }
  const raw = aws(['s3api', 'head-object', '--bucket', bucket, '--key', 'index.html', '--output', 'json'])
  const meta = JSON.parse(raw)
  const etag = (meta.ETag || '').replace(/"/g, '')
  if (!etag) {
    throw new Error(`s3://${bucket}/index.html의 ETag를 못 읽었습니다.`)
  }
  return etag
}

export function parseGitOpsImages(yamlText) {
  const result = {}
  let currentName = null
  for (const line of yamlText.split('\n')) {
    const nameMatch = line.match(/^\s*-\s*name:\s*(\S+)/)
    if (nameMatch) {
      currentName = nameMatch[1]
      continue
    }
    const digestMatch = line.match(/^\s*digest:\s*(\S+)\s*#\s*source-revision:\s*(\S+)/)
    if (digestMatch && currentName) {
      result[currentName] = { digest: digestMatch[1], sourceRevision: digestMatch[2] }
    }
  }
  return result
}

function normalizeRevision(entry) {
  if (!entry) return 'unknown'
  if (UNCONFIGURED_MARKERS.has(entry.digest) || UNCONFIGURED_MARKERS.has(entry.sourceRevision)) return 'unknown'
  return `${entry.sourceRevision}@${entry.digest}`
}

function resolveGitOpsRevisions() {
  if (!existsSync(GITOPS_KUSTOMIZATION)) {
    console.warn(
      `GitOps kustomization.yaml을 못 찾았습니다: ${GITOPS_KUSTOMIZATION} — edge/storeAccess Revision은 ` +
        '"unknown"으로 둡니다.',
    )
    return { edge: 'unknown', storeAccess: 'unknown' }
  }
  const yamlText = readFileSync(GITOPS_KUSTOMIZATION, 'utf8')
  const images = parseGitOpsImages(yamlText)
  return {
    edge: normalizeRevision(images['doro-erp-edge']),
    storeAccess: normalizeRevision(images['doro-erp-store-access']),
  }
}

function main() {
  checkCredentials()

  console.log(`CloudFront Distribution 조회 중 (Alias: ${FRONTEND_DOMAIN})...`)
  const { Id: distributionId, OriginDomain: originDomain } = resolveCloudFront(FRONTEND_DOMAIN)
  console.log(`  distributionId=${distributionId} originDomain=${originDomain}`)

  console.log('Frontend Revision(S3 ETag) 조회 중...')
  let frontendRevision
  try {
    frontendRevision = resolveFrontendRevision(originDomain)
  } catch (error) {
    console.warn(
      `Frontend Revision 조회 실패 — "unknown"으로 둡니다: ${error instanceof Error ? error.message : error}`,
    )
    frontendRevision = 'unknown'
  }

  console.log('GitOps에서 Edge/Store Access Revision 조회 중...')
  const { edge, storeAccess } = resolveGitOpsRevisions()

  const lines = [
    '# scripts/resolve-deployment-identity.mjs가 생성 — 커밋 금지 (.env.*.local 패턴)',
    `DORO_FRONTEND_REVISION=${frontendRevision}`,
    `DORO_CLOUDFRONT_DISTRIBUTION_ID=${distributionId}`,
    `DORO_EDGE_REVISION=${edge}`,
    `DORO_STORE_ACCESS_REVISION=${storeAccess}`,
    '',
  ]
  writeFileSync(outPath, lines.join('\n'), 'utf8')

  console.log('')
  console.log(`DORO_FRONTEND_REVISION=${frontendRevision}`)
  console.log(`DORO_CLOUDFRONT_DISTRIBUTION_ID=${distributionId}`)
  console.log(`DORO_EDGE_REVISION=${edge}`)
  console.log(`DORO_STORE_ACCESS_REVISION=${storeAccess}`)
  console.log('')
  console.log(`기록 완료: ${outPath}`)
  console.log(
    'doro-erp-e2e 실행 시 다음처럼 불러와 쓰세요 (bash): set -a; source .env.deployment-identity.local; set +a',
  )

  const anyUnknown = [frontendRevision, distributionId, edge, storeAccess].some((v) => !v || v === 'unknown')
  if (anyUnknown) {
    console.warn('')
    console.warn(
      '⚠ 하나 이상의 Revision이 "unknown"입니다 — deploymentIdentityComplete=false가 됩니다. 스크립트 ' +
        '버그가 아니라 아직 GitOps로 실제 릴리스되지 않은 상태를 그대로 반영한 것일 수 있습니다.',
    )
  }
}

// 이 파일이 직접 실행될 때만 main()을 돈다 — parseGitOpsImages()를 다른 스크립트/테스트에서
// import해서 재사용할 수 있게 하기 위함이다.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
