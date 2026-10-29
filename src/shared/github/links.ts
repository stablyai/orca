// Share URL parsing between main terminal side-effect PR facts and renderer link pickers (terminal-side-effect-authority.md, slice 3).
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
  // Preserve GHES identity instead of defaulting Enterprise links to github.com.
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

/** Parse bare/# issue or PR numbers and full GitHub URLs. */
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

/** Parse owner/repo/number from GitHub-shaped issue/PR URLs; return null for other inputs. */
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
    // URL identity must preserve GHES server and non-default port; hostname would redirect API calls to 443.
    slug: { owner: match[1], repo: match[2], host: url.host },
    type: match[3].toLowerCase() === 'pull' ? 'pr' : 'issue',
    number
  }
}
