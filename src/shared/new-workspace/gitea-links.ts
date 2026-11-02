import { isWorkItemLinkQueryTooLarge } from './work-item-link-query-bounds'

// Why: Gitea PR URLs use /pulls/N, which GitHub never does; /issues/N is shared with GitHub.
const GITEA_ITEM_PATH_RE = /^\/(.+?)\/(issues|pulls)\/(\d+)(?:\/.*)?$/i
const KNOWN_GITEA_HOSTS = new Set(['codeberg.org', 'gitea.com'])

export type GiteaProjectSlug = {
  host: string
  /** `owner/repo` path on the Gitea instance. */
  path: string
}

export type GiteaIssueOrPRLink = {
  slug: GiteaProjectSlug
  number: number
  type: 'issue' | 'pr'
}

export type GiteaLinkQuery = {
  query: string
  directNumber: number | null
  tooLarge?: boolean
}

export function isKnownGiteaHost(host: string): boolean {
  return KNOWN_GITEA_HOSTS.has(host.toLowerCase().replace(/:\d+$/, ''))
}

/**
 * Read host/path, number and type from a Gitea work-item URL. `/issues/N` is ambiguous with
 * GitHub, so it only matches known Gitea hosts unless `assumeGitea` is set.
 */
export function parseGiteaIssueOrPRLink(
  input: string,
  options: { assumeGitea?: boolean } = {}
): GiteaIssueOrPRLink | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return null
  }
  const match = GITEA_ITEM_PATH_RE.exec(url.pathname.replace(/\/+$/, ''))
  if (!match) {
    return null
  }
  const path = match[1]
  const segments = path.split('/')
  if (segments.length !== 2 || segments.some((segment) => !segment)) {
    return null
  }
  const type = match[2].toLowerCase() === 'pulls' ? 'pr' : 'issue'
  if (type === 'issue' && !options.assumeGitea && !isKnownGiteaHost(url.host)) {
    return null
  }
  const number = Number.parseInt(match[3], 10)
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null
  }
  return { slug: { host: url.host, path }, number, type }
}

/** Accept bare, `#issue`, `!PR` numbers and `owner/repo#N` references. */
export function parseGiteaIssueOrPRNumber(input: string): number | null {
  const trimmed = input.trim()
  const numeric = /^[#!]/.test(trimmed) ? trimmed.slice(1) : trimmed
  if (!/^\d+$/.test(numeric)) {
    return null
  }
  const number = Number.parseInt(numeric, 10)
  return number > 0 ? number : null
}

export function normalizeGiteaLinkQuery(raw: string): GiteaLinkQuery {
  if (isWorkItemLinkQueryTooLarge(raw)) {
    return { query: '', directNumber: null, tooLarge: true }
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    return { query: '', directNumber: null }
  }
  const direct = parseGiteaIssueOrPRNumber(trimmed)
  if (direct !== null) {
    return { query: trimmed, directNumber: direct }
  }
  const link = parseGiteaIssueOrPRLink(trimmed)
  return { query: trimmed, directNumber: link ? link.number : null }
}

export type GiteaWorkItemReference = {
  number: number
  /** Null when the reference does not say whether it names an issue or a PR. */
  type: 'issue' | 'pr' | null
  /** Set for `owner/repo#N` and pasted URLs; otherwise the repo's own project applies. */
  host: string | null
  path: string | null
}

const GITEA_OWNER_REPO_REFERENCE_RE = /^([\w.-]+\/[\w.-]+)?([#!])(\d+)$/

/** Read `#N`, `!N`, `N`, `owner/repo#N` and Gitea item URLs into one lookup reference. */
export function parseGiteaWorkItemReference(input: string): GiteaWorkItemReference | null {
  const trimmed = input.trim()
  if (!trimmed || isWorkItemLinkQueryTooLarge(trimmed)) {
    return null
  }
  const link = parseGiteaIssueOrPRLink(trimmed, { assumeGitea: true })
  if (link) {
    return { number: link.number, type: link.type, host: link.slug.host, path: link.slug.path }
  }
  const bare = parseGiteaIssueOrPRNumber(trimmed)
  if (bare !== null && !/^[#!]/.test(trimmed)) {
    return { number: bare, type: null, host: null, path: null }
  }
  const match = GITEA_OWNER_REPO_REFERENCE_RE.exec(trimmed)
  if (!match) {
    return null
  }
  const number = Number.parseInt(match[3], 10)
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null
  }
  return {
    number,
    type: match[2] === '!' ? 'pr' : null,
    host: null,
    path: match[1] ?? null
  }
}
