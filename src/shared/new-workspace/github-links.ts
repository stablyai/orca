import {
  type GitHubIssueOrPRLink,
  parseGitHubIssueOrPRLink,
  parseGitHubIssueOrPRNumber
} from '../github/repositories/links'
import {
  parseGitHubIssueReference,
  resolveGitHubIssueReference
} from '../github/repositories/github-issue-reference'
import { isWorkItemLinkQueryTooLarge } from './work-item-link-query-bounds'

const HTTP_URL_PREFIX_RE = /^https?:\/\//i

export type GitHubLinkQuery = {
  query: string
  directNumber: number | null
  directLink?: GitHubIssueOrPRLink
  isIssueShorthand?: true
  tooLarge?: boolean
}

export function normalizeGitHubLinkQuery(raw: string, host?: string): GitHubLinkQuery {
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

  const reference = parseGitHubIssueReference(trimmed)
  if (reference?.kind === 'shorthand') {
    const issue = resolveGitHubIssueReference(reference, { host })
    if (issue?.kind === 'url') {
      return {
        query: trimmed,
        directNumber: issue.number,
        directLink: {
          slug: { owner: issue.owner, repo: issue.repo, host: issue.host },
          number: issue.number,
          type: 'issue'
        },
        isIssueShorthand: true
      }
    }
  }

  const link = parseGitHubIssueOrPRLink(trimmed)
  if (!link) {
    return { query: trimmed, directNumber: null }
  }

  // Accept upstream numbers across differing fork/origin slugs.
  return {
    query: trimmed,
    directNumber: link.number,
    directLink: link
  }
}
