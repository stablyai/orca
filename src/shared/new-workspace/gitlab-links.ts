import { isWorkItemLinkQueryTooLarge } from './work-item-link-query-bounds'

// Why: GitLab project paths can include nested groups, and the host may
// be self-hosted (gitlab.example.com), so the URL pattern uses the
// project-internal `/-/` separator as the GitLab-specific signal rather
// than locking to gitlab.com. Anything matching `/<path>/-/(issues|
// work_items|merge_requests)/<digits>` is treated as a GitLab item URL
// regardless of host. Modern GitLab emits issue URLs as
// `/-/work_items/<iid>`; treat that as an issue work item, same as the
// legacy `/-/issues/<iid>` form.
const GL_ITEM_PATH_RE = /\/(?:issues|work_items|merge_requests)\/(\d+)(?:\/.*)?$/i
const GL_ITEM_PATH_FULL_RE = /^\/(.+)\/-\/(issues|work_items|merge_requests)\/(\d+)(?:\/.*)?$/i

// Why: same guards as the GitHub parser two files over (github/links.ts:32-35,59-60).
// `/^\d+$/` accepts 400 digits, which parseInt turns into Infinity — JSON.stringify
// then persists `null`, and a `0` iid reads as "no issue" at every truthiness check.
function gitLabItemNumber(value: string): number | null {
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export type ProjectSlug = {
  /** GitLab hostname, preserving self-hosted instances from pasted URLs. */
  host: string
  /** Full GitLab project path including any nested groups. */
  path: string
}

export type GitLabLinkQuery = {
  query: string
  directNumber: number | null
  tooLarge?: boolean
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
    return gitLabItemNumber(numeric)
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
  return gitLabItemNumber(match[1])
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

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
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

  const number = gitLabItemNumber(match[3])
  if (number === null) {
    return null
  }

  return {
    slug: { host: url.host, path },
    type: match[2].toLowerCase() === 'merge_requests' ? 'mr' : 'issue',
    number
  }
}

/** The canonical web URL for a GitLab issue. The host comes from the project slug,
 *  never a default — self-hosted is the normal case, not the exception. Path segments
 *  are encoded individually so nested group paths keep their separators. */
export function buildGitLabIssueUrl(slug: ProjectSlug, number: number): string | null {
  if (!slug.host || !slug.path) {
    return null
  }
  const path = slug.path.split('/').map(encodeURIComponent).join('/')
  return `https://${slug.host}/${path}/-/issues/${number}`
}

/**
 * Normalize link-picker input so both raw issue/MR numbers and full
 * GitLab URLs resolve to a usable query + direct-number lookup.
 */
export function normalizeGitLabLinkQuery(raw: string): GitLabLinkQuery {
  if (isWorkItemLinkQueryTooLarge(raw)) {
    return { query: '', directNumber: null, tooLarge: true }
  }
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
