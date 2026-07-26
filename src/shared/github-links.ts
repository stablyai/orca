// Why shared: main's terminal side-effect tracker emits pr-link facts
// (terminal-side-effect-authority.md, slice 3) and needs the same GitHub URL
// parsing core the renderer link picker uses.
const GH_ITEM_PATH_RE = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/i

export type RepoSlug = {
  owner: string
  repo: string
  host?: string
}

export type GitHubIssueOrPRLink = {
  slug: RepoSlug
  number: number
  type: 'issue' | 'pr'
}

export function buildGitHubRepoUrl(slug: RepoSlug | null | undefined): string | null {
  if (!slug?.owner || !slug.repo) {
    return null
  }
  // Why: hosted identities carry the GHES host; links must point at that
  // server, not github.com.
  const host = slug.host ?? 'github.com'
  return `https://${host}/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}`
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
    // Why: the URL proves the host — GHES links must keep their server identity
    // instead of being treated as github.com slugs.
    // Why: GHES installations on non-default ports require the full URL host;
    // `hostname` would silently redirect later API calls to port 443.
    slug: { owner: match[1], repo: match[2], host: url.host },
    type: match[3].toLowerCase() === 'pull' ? 'pr' : 'issue',
    number
  }
}
