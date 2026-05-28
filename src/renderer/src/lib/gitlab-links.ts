// Why: GitLab project paths can include nested groups, and the host may
// be self-hosted (gitlab.example.com), so the URL pattern uses the
// project-internal `/-/` separator as the GitLab-specific signal rather
// than locking to gitlab.com. Anything matching `/<path>/-/(issues|
// merge_requests)/<digits>` is treated as a GitLab item URL regardless
// of host.
const GL_ITEM_PATH_RE = /\/(?:issues|merge_requests)\/(\d+)(?:\/)?$/i
const GL_ITEM_PATH_FULL_RE = /^\/(.+)\/-\/(issues|merge_requests)\/(\d+)(?:\/)?$/i

export type ProjectSlug = {
  /** Full GitLab project path including any nested groups. */
  path: string
}

export type GitLabLinkQuery = {
  query: string
  directNumber: number | null
}

/**
 * Parse a GitLab issue or MR reference from plain input. Accepts:
 *   - bare numbers ("42")
 *   - hash-prefixed numbers ("#42")
 *   - exclamation-prefixed numbers ("!42") — GitLab convention for MRs
 *   - full GitLab URLs (any host) for issues or merge_requests
 */
export function parseGitLabIssueOrMRNumber(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  // Why: GitLab references issues with `#` and MRs with `!` in markdown
  // and copy-paste contexts. Accept both prefixes so users can drop in
  // either form.
  const numeric = trimmed.startsWith('#') || trimmed.startsWith('!') ? trimmed.slice(1) : trimmed
  if (/^\d+$/.test(numeric)) {
    return Number.parseInt(numeric, 10)
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  const match = GL_ITEM_PATH_RE.exec(url.pathname)
  if (!match) {
    return null
  }
  // Why: the basic pattern matches plain GitHub URLs too (e.g.
  // /owner/repo/issues/123). Require the `/-/` separator that's
  // unique to GitLab to avoid mis-classifying a GitHub URL.
  if (!url.pathname.includes('/-/')) {
    return null
  }
  return Number.parseInt(match[1], 10)
}

/**
 * Parse a GitLab URL into project path + iid + type. Returns null for
 * anything that isn't a recognizable GitLab issue or merge-request URL.
 */
export function parseGitLabIssueOrMRLink(input: string): {
  slug: ProjectSlug
  number: number
  type: 'issue' | 'mr'
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

  const match = GL_ITEM_PATH_FULL_RE.exec(url.pathname)
  if (!match) {
    return null
  }

  const path = match[1]
  // Why: a project path needs at least one slash (group/project). A
  // single-segment path is the user/group root, not a project.
  if (!path.includes('/')) {
    return null
  }

  return {
    slug: { path },
    type: match[2].toLowerCase() === 'merge_requests' ? 'mr' : 'issue',
    number: Number.parseInt(match[3], 10)
  }
}

/**
 * Normalize link-picker input so both raw issue/MR numbers and full
 * GitLab URLs resolve to a usable query + direct-number lookup.
 */
export function normalizeGitLabLinkQuery(raw: string): GitLabLinkQuery {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { query: '', directNumber: null }
  }

  const direct = parseGitLabIssueOrMRNumber(trimmed)
  if (direct !== null && !trimmed.startsWith('http')) {
    return { query: trimmed, directNumber: direct }
  }

  const link = parseGitLabIssueOrMRLink(trimmed)
  if (!link) {
    return { query: trimmed, directNumber: null }
  }

  // Why: any GitLab issue/MR URL is accepted by number regardless of
  // project slug, mirroring the GitHub-side behavior — fork checkouts
  // can legitimately target an upstream's issue numbers.
  return {
    query: trimmed,
    directNumber: link.number
  }
}
