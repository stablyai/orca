import { getSmartGitHubSubmitIntent } from './smart-github-submit'
import { parseGitLabIssueOrMRLink } from './gitlab-links'

const LINEAR_ISSUE_URL_RE = /^https?:\/\/(?:www\.)?linear\.app\/\S+/i

/**
 * Why: text typed into the smart name field to *find* a work item — a GitHub
 * or GitLab URL, "#123", or a linear.app link — is a lookup query, never a
 * deliberate workspace name. Selection handlers use this to decide that the
 * resolved item's title-derived name may replace the field content; otherwise
 * the pasted URL silently survives behind the selection pill and the
 * workspace gets a slugified-URL name.
 */
export function isWorkItemLookupText(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  return (
    getSmartGitHubSubmitIntent(trimmed) !== null ||
    parseGitLabIssueOrMRLink(trimmed) !== null ||
    LINEAR_ISSUE_URL_RE.test(trimmed)
  )
}
