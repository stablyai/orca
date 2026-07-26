// Why: the parsing core moved to shared so main's terminal side-effect
// tracker can emit pr-link facts (terminal-side-effect-authority.md, slice 3).
// Re-exported here so renderer consumers keep their '@/lib' import path.
// normalizeGitHubLinkQuery stays renderer-side: its too-large guard is link-
// picker input policy, not parsing.
import {
  type GitHubIssueOrPRLink,
  parseGitHubIssueOrPRLink,
  parseGitHubIssueOrPRNumber
} from '../../../shared/github-links'

import { isWorkItemLinkQueryTooLarge } from './work-item-link-query-bounds'

export * from '../../../shared/github-links'

const HTTP_URL_PREFIX_RE = /^https?:\/\//i

export type GitHubLinkQuery = {
  query: string
  directNumber: number | null
  directLink?: GitHubIssueOrPRLink
  tooLarge?: boolean
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
