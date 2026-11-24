import { parseClickUpTaskReference } from '../clickup/clickup-task-reference'
import { parseJiraIssueUrl } from '../jira/jira-issue-url'
import { parseLinearIssueUrlIntent } from '../linear/links'
import type { WorkspaceAttachment } from '../worktree/types'

/** Linear, Jira and ClickUp reference URLs, normalized in place; null when `url` is none of them. */
export function parseTaskTrackerReferenceUrl(
  url: URL,
  providerHint?: WorkspaceAttachment['provider']
): WorkspaceAttachment | null {
  const linear = parseLinearIssueUrlIntent(url.href)
  if (linear) {
    url.pathname = `/${linear.organizationUrlKey.toLowerCase()}/issue/${linear.identifier}`
    return {
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: linear.identifier,
      linearIdentifier: linear.identifier,
      linearOrganizationUrlKey: linear.organizationUrlKey.toLowerCase(),
      url: url.href
    }
  }
  // Git hosts (and Bitbucket Server /repos/ file views) also serve /browse/KEY-1 paths.
  const jira =
    (!providerHint || providerHint === 'jira') && !url.pathname.includes('/repos/')
      ? parseJiraIssueUrl(url.href)
      : null
  if (jira) {
    url.pathname = `${jira.sitePath}/browse/${jira.issueKey}`
    return {
      provider: 'jira',
      type: 'issue',
      number: 0,
      identifier: jira.issueKey,
      jiraIdentifier: jira.issueKey,
      url: url.href
    }
  }
  const clickup =
    !providerHint || providerHint === 'clickup' ? parseClickUpTaskReference(url.href) : null
  if (clickup) {
    const clickupIdentifier = clickup.kind === 'id' ? clickup.id : clickup.customId
    url.pathname =
      clickup.kind === 'custom-id' && clickup.workspaceId
        ? `/t/${clickup.workspaceId}/${clickupIdentifier}`
        : `/t/${clickupIdentifier}`
    // No `identifier`: ClickUp ids are case-sensitive, so identity comes from the URL path alone.
    return { provider: 'clickup', type: 'issue', number: 0, clickupIdentifier, url: url.href }
  }
  return null
}
