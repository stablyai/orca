const GH_ITEM_PATH_RE = /^\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)(?:\/)?$/i
const GH_ITEM_PATH_FULL_RE = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:\/)?$/i

export type RepoSlug = {
  owner: string
  repo: string
}

export type GitHubLinkQuery = {
  query: string
  directNumber: number | null
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
    return Number.parseInt(numeric, 10)
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) {
    return null
  }

  const match = GH_ITEM_PATH_RE.exec(url.pathname)
  if (!match) {
    return null
  }

  return Number.parseInt(match[1], 10)
}

/**
 * Parses an owner/repo slug plus issue/PR number from a GitHub URL. Returns
 * null for anything that isn't a recognizable github.com issue or pull URL.
 */
export function parseGitHubIssueOrPRLink(input: string): {
  slug: RepoSlug
  number: number
} | null {
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

  if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) {
    return null
  }

  const match = GH_ITEM_PATH_FULL_RE.exec(url.pathname)
  if (!match) {
    return null
  }

  return {
    slug: { owner: match[1], repo: match[2] },
    number: Number.parseInt(match[3], 10)
  }
}

/**
 * Normalizes link-picker input so both raw issue/PR numbers and full GitHub
 * URLs resolve to a usable query + direct-number lookup.
 */
export function normalizeGitHubLinkQuery(raw: string): GitHubLinkQuery {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { query: '', directNumber: null }
  }

  const direct = parseGitHubIssueOrPRNumber(trimmed)
  if (direct !== null && !trimmed.startsWith('http')) {
    return { query: trimmed, directNumber: direct }
  }

  const link = parseGitHubIssueOrPRLink(trimmed)
  if (!link) {
    return { query: trimmed, directNumber: null }
  }

  // Why: any github.com issue/pull URL is accepted by number regardless of
  // slug, since fork checkouts can legitimately target upstream issues whose
  // slug differs from the origin remote.
  return {
    query: trimmed,
    directNumber: link.number
  }
}
