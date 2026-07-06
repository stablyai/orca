import { isWorkItemLinkQueryTooLarge } from './work-item-link-query-bounds'

const GH_ITEM_PATH_RE = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/i
const HTTP_URL_PREFIX_RE = /^https?:\/\//i

export type RepoSlug = {
  owner: string
  repo: string
}

export type GitHubIssueOrPRLink = {
  slug: RepoSlug
  number: number
  type: 'issue' | 'pr'
}

export type GitHubLinkQuery = {
  query: string
  directNumber: number | null
  directLink?: GitHubIssueOrPRLink
  tooLarge?: boolean
}

export function buildGitHubRepoUrl(slug: RepoSlug | null | undefined): string | null {
  if (!slug?.owner || !slug.repo) {
    return null
  }
  return `https://github.com/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}`
}

function matchGitHubItemPath(url: URL): RegExpExecArray | null {
  return GH_ITEM_PATH_RE.exec(url.pathname.replace(/\/+$/, ''))
}

function parseGitHubItemNumber(value: string): number | null {
  const parsed = Number.parseInt(value, 10)
  return parsed > 0 ? parsed : null
}

/**
 * Parses a GitHub issue/PR reference from plain input.
 * Supports issue/PR numbers (e.g. "42"), "#42", and full GitHub URLs.
 */
export function parseGitHubIssueOrPRNumber(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const numeric = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  if (/^\d+$/.test(numeric)) {
    return parseGitHubItemNumber(numeric)
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }

  const match = matchGitHubItemPath(url)
  if (!match) {
    return null
  }

  return parseGitHubItemNumber(match[4])
}

/**
 * Parses an owner/repo slug plus issue/PR number from a GitHub URL. Returns
 * null for anything that isn't a recognizable GitHub-shaped issue or pull URL.
 */
export function parseGitHubIssueOrPRLink(input: string): GitHubIssueOrPRLink | null {
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

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }

  const match = matchGitHubItemPath(url)
  if (!match) {
    return null
  }
  const number = parseGitHubItemNumber(match[4])
  if (number === null) {
    return null
  }

  return {
    slug: { owner: match[1], repo: match[2] },
    type: match[3].toLowerCase() === 'pull' ? 'pr' : 'issue',
    number
  }
}

/**
 * Normalizes link-picker input so both raw issue/PR numbers and full GitHub
 * URLs resolve to a usable query + direct-number lookup.
 */
export function normalizeGitHubLinkQuery(raw: string): GitHubLinkQuery {
  if (isWorkItemLinkQueryTooLarge(raw)) {
    return { query: '', directNumber: null, tooLarge: true }
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    return { query: '', directNumber: null }
  }

  const direct = parseGitHubIssueOrPRNumber(trimmed)
  if (direct !== null && !HTTP_URL_PREFIX_RE.test(trimmed)) {
    return { query: trimmed, directNumber: direct }
  }

  const link = parseGitHubIssueOrPRLink(trimmed)
  if (!link) {
    return { query: trimmed, directNumber: null }
  }

  // Why: any GitHub-shaped issue/pull URL is accepted by number regardless of
  // slug, since fork checkouts can legitimately target upstream issues whose
  // slug differs from the origin remote.
  return {
    query: trimmed,
    directNumber: link.number,
    directLink: link
  }
}
