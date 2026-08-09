import { parseJiraIssueUrl } from './jira-issue-url'
import type { TaskSourceContext } from './task-source-context'
import type { JiraIssueLink, WorkspaceLinkedItem } from './types'

export function normalizeJiraIssueLink(value: unknown): JiraIssueLink | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<JiraIssueLink>
  const key = typeof raw.key === 'string' ? raw.key.trim().toUpperCase() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const parsedUrl = typeof raw.url === 'string' ? parseJiraIssueUrl(raw.url) : null
  if (!key || !parsedUrl || parsedUrl.issueKey !== key) {
    return null
  }
  return {
    key,
    // Identity is site + key; a blank summary must not throw the whole link away.
    title: title || key,
    url: `${parsedUrl.origin}${parsedUrl.sitePath}/browse/${parsedUrl.issueKey}`
  }
}

export function areJiraIssueLinksEqual(
  a: JiraIssueLink | null | undefined,
  b: JiraIssueLink | null | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return !a && !b
  }
  return a.key === b.key && a.title === b.title && a.url === b.url
}

export function jiraIssueLinkFromLegacyWorkItem(
  item: WorkspaceLinkedItem | null | undefined
): JiraIssueLink | null {
  if (item?.provider !== 'jira' || item.type !== 'issue') {
    return null
  }
  const parsedUrl = parseJiraIssueUrl(item.url)
  const key = item.jiraIdentifier?.trim().toUpperCase() || parsedUrl?.issueKey
  if (!parsedUrl || !key || parsedUrl.issueKey !== key) {
    return null
  }
  return normalizeJiraIssueLink({
    key,
    title: withoutRepeatedJiraKey(item.title, key),
    url: item.url
  })
}

export function resolveJiraIssueLink(fields: {
  linkedJiraIssue?: JiraIssueLink | null
  linkedWorkItem?: WorkspaceLinkedItem | null
}): JiraIssueLink | null {
  if (fields.linkedJiraIssue === undefined) {
    return jiraIssueLinkFromLegacyWorkItem(fields.linkedWorkItem)
  }
  const dedicated = normalizeJiraIssueLink(fields.linkedJiraIssue)
  if (dedicated) {
    return dedicated
  }
  // Explicit null is a real unlink and stays one; a corrupt object is an unreadable
  // opinion, so it must not permanently mask a legacy Jira link that still parses.
  return fields.linkedJiraIssue === null
    ? null
    : jiraIssueLinkFromLegacyWorkItem(fields.linkedWorkItem)
}

export function isJiraIssueLinkSourceContextMatch(
  issue: JiraIssueLink | null | undefined,
  context: TaskSourceContext | null | undefined
): boolean {
  if (!issue || context?.provider !== 'jira') {
    return false
  }
  const identity = context.providerIdentity
  const issueUrl = parseJiraIssueUrl(issue.url)
  // No siteId gate: identity is origin + site path + project key, and Jira Server
  // contexts carry no cloud siteId to offer.
  if (identity?.provider !== 'jira' || !identity.siteUrl || !identity.projectKey || !issueUrl) {
    return false
  }
  const siteUrl = parseJiraIssueUrl(
    `${identity.siteUrl.replace(/\/+$/g, '')}/browse/${issueUrl.issueKey}`
  )
  const projectKey = issueUrl.issueKey.slice(0, issueUrl.issueKey.lastIndexOf('-'))
  return (
    issue.key.toUpperCase() === issueUrl.issueKey &&
    identity.projectKey.toUpperCase() === projectKey &&
    siteUrl !== null &&
    issueUrl.origin === siteUrl.origin &&
    issueUrl.sitePath === siteUrl.sitePath
  )
}

export function resolveJiraIssueSourceContext(fields: {
  linkedJiraIssue?: JiraIssueLink | null
  linkedJiraIssueSourceContext?: TaskSourceContext | null
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
}): TaskSourceContext | null {
  // The context belongs to whichever field actually supplied the issue, so a
  // corrupt dedicated link falls back to the legacy pair as a unit.
  const dedicatedIssue =
    fields.linkedJiraIssue === undefined ? null : normalizeJiraIssueLink(fields.linkedJiraIssue)
  if (dedicatedIssue) {
    return isJiraIssueLinkSourceContextMatch(dedicatedIssue, fields.linkedJiraIssueSourceContext)
      ? (fields.linkedJiraIssueSourceContext ?? null)
      : null
  }
  if (fields.linkedJiraIssue === null) {
    return null
  }
  const legacyIssue = jiraIssueLinkFromLegacyWorkItem(fields.linkedWorkItem)
  return isJiraIssueLinkSourceContextMatch(legacyIssue, fields.linkedTaskSourceContext)
    ? (fields.linkedTaskSourceContext ?? null)
    : null
}

function withoutRepeatedJiraKey(title: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = title.replace(new RegExp(`^${escapedKey}(?:\\s*[:—-]\\s*|\\s+)`, 'i'), '').trim()
  return stripped || title.trim()
}
