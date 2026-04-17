const GH_ITEM_PATH_RE = /^\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)(?:\/)?$/i
const GH_ITEM_PATH_FULL_RE = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:\/)?$/i

export type RepoSlug = {
  owner: string
  repo: string
}

export type GitHubLinkQuery = {
  query: string
  repoMismatch: string | null
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
 * URLs resolve to a usable query + direct-number lookup. Returns a repo
 * mismatch when a URL targets a different repo than the selected one.
 */
export function normalizeGitHubLinkQuery(raw: string, repoSlug: RepoSlug | null): GitHubLinkQuery {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { query: '', repoMismatch: null, directNumber: null }
  }

  const direct = parseGitHubIssueOrPRNumber(trimmed)
  if (direct !== null && !trimmed.startsWith('http')) {
    return { query: trimmed, repoMismatch: null, directNumber: direct }
  }

  const link = parseGitHubIssueOrPRLink(trimmed)
  if (!link) {
    return { query: trimmed, repoMismatch: null, directNumber: null }
  }

  if (
    repoSlug &&
    (link.slug.owner.toLowerCase() !== repoSlug.owner.toLowerCase() ||
      link.slug.repo.toLowerCase() !== repoSlug.repo.toLowerCase())
  ) {
    return {
      query: '',
      repoMismatch: `${repoSlug.owner}/${repoSlug.repo}`,
      directNumber: null
    }
  }

  return {
    query: trimmed,
    repoMismatch: null,
    directNumber: link.number
  }
}
