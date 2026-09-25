import { parseGitHubIssueOrPRLink, parseGitHubIssueOrPRNumber } from './github-links'
import { parseGitLabIssueOrMRLink } from './gitlab-links'
import { parseJiraIssueUrl } from '../jira-issue-url'

const LINEAR_ISSUE_URL_RE = /^https?:\/\/(?:www\.)?linear\.app\/[^/\s]+\/issue\/[^/\s]+(?:\/\S*)?$/i
const GITHUB_ITEM_URL_IN_TEXT_RE =
  /https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+[^\s]*/i
const TRAILING_URL_PUNCTUATION_RE = /[),.;:!?]+$/

/** Name fields treat a bare number as a deliberate name; only "#123" marks a lookup. */
function isHashPrefixedGitHubIssueOrPRNumber(value: string): boolean {
  return value.startsWith('#') && parseGitHubIssueOrPRNumber(value) !== null
}

/** Matches "#123", a whole issue/PR URL, or one embedded in longer text. */
function hasGitHubLookup(value: string): boolean {
  if (isHashPrefixedGitHubIssueOrPRNumber(value) || parseGitHubIssueOrPRLink(value) !== null) {
    return true
  }
  const embedded = GITHUB_ITEM_URL_IN_TEXT_RE.exec(value)?.[0]
  return embedded
    ? parseGitHubIssueOrPRLink(embedded.replace(TRAILING_URL_PUNCTUATION_RE, '')) !== null
    : false
}

/** Lookup references may be replaced by an auto-name; deliberate names may not. */
export function isWorkItemLookupText(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  return (
    hasGitHubLookup(trimmed) ||
    parseGitLabIssueOrMRLink(trimmed) !== null ||
    parseJiraIssueUrl(trimmed) !== null ||
    LINEAR_ISSUE_URL_RE.test(trimmed)
  )
}
