import { isWorkItemLinkQueryTooLarge } from './work-item-link-query-bounds'

// Use /-/ as the GitLab signal across self-hosted instances and nested groups. Both /issues and modern /work_items name issues;
// /merge_requests names MRs, regardless of host.
const GL_ITEM_PATH_RE = /\/(?:issues|work_items|merge_requests)\/(\d+)(?:\/.*)?$/i
const GL_ITEM_PATH_FULL_RE = /^\/(.+)\/-\/(issues|work_items|merge_requests)\/(\d+)(?:\/.*)?$/i

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

/** Accept bare, #issue, !MR numbers or any-host GitLab issue/work_items/merge_requests URLs. */
export function parseGitLabIssueOrMRNumber(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  // Accept GitLab’s copied #issue and !MR references.
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
  // Require GitLab’s /-/ separator or the basic issue pattern also accepts GitHub URLs.
  if (!url.pathname.includes('/-/')) {
    return null
  }
  return Number.parseInt(match[1], 10)
}

/** Read project host/path, iid and type from a recognizable GitLab work-item URL. */
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
  // Projects require group/project, unlike single-segment user/group roots.
  if (!path.includes('/')) {
    return null
  }

  return {
    slug: { host: url.host, path },
    type: match[2].toLowerCase() === 'merge_requests' ? 'mr' : 'issue',
    number: Number.parseInt(match[3], 10)
  }
}

/** Resolve issue/MR numbers or GitLab URLs into search query and direct-number lookup. */
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

  // Like GitHub, allow upstream numbers with differing fork/project slugs.
  return {
    query: trimmed,
    directNumber: link.number
  }
}
