import { JIRA_ISSUE_KEY_PATTERN, parseJiraIssueUrl } from './jira-issue-url'
import { escapeRegex } from '../string-utils'
import { getWorkspaceAttachments } from '../workspace-attachments'
import type { WorkspaceAttachmentMetadata } from '../workspace-attachment-legacy'
import type { WorkspaceAttachment } from '../worktree/types'

function attachmentJiraIssueKey(item: WorkspaceAttachment): string | null {
  if (item.provider !== 'jira' || item.type !== 'issue') {
    return null
  }
  const parsed = item.url ? parseJiraIssueUrl(item.url) : null
  const key = (item.jiraIdentifier ?? item.identifier ?? parsed?.issueKey)?.trim().toUpperCase()
  if (!key || !JIRA_ISSUE_KEY_PATTERN.test(key)) {
    return null
  }
  if (item.url && (!parsed || parsed.issueKey !== key)) {
    return null
  }
  return key
}

export function getWorkspaceJiraIssueKey(
  workspace: WorkspaceAttachmentMetadata | null | undefined
): string | null {
  const items = getWorkspaceAttachments(workspace)
  const primary = workspace?.linkedWorkItem
  if (primary?.provider === 'jira') {
    const key = attachmentJiraIssueKey(primary)
    if (key) {
      return key
    }
  }
  const keys = new Set(items.map(attachmentJiraIssueKey).filter((key) => key !== null))
  // Several attached tasks do not establish which issue owns a new review.
  return keys.size === 1 ? [...keys][0] : null
}

export function prefixJiraReviewTitle(
  title: string,
  jiraIssueKey: string | null | undefined
): string {
  const key = jiraIssueKey?.trim().toUpperCase()
  if (!key || !JIRA_ISSUE_KEY_PATTERN.test(key)) {
    return title
  }
  const prefix = new RegExp(`^\\[?${escapeRegex(key)}\\]?(?=$|[\\s:-])(?:[\\s:-]+)?`, 'i')
  let subject = title.trim()
  // Generated text can repeat or decorate the key; retain one exact canonical prefix.
  while (prefix.test(subject)) {
    subject = subject.replace(prefix, '').trimStart()
  }
  return [key, subject].filter(Boolean).join(' ')
}
