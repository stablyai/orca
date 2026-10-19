import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { parseGitLabIssueOrMRLink } from '../../../../shared/new-workspace/gitlab-links'
import { parseLinearIssueInput } from '../../../../shared/linear/links'
import { parseJiraIssueUrl } from '../../../../shared/jira-issue-url'
import { getWorkspaceAttachmentUrlScope } from '../../../../shared/workspace-attachment-normalization'

function humanText(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(text) ? text : null
}

function joinSourceParts(...parts: (string | null | undefined)[]): string | null {
  const labels = new Map<string, string>()
  for (const part of parts) {
    const label = humanText(part)
    if (label && !labels.has(label.toLowerCase())) {
      labels.set(label.toLowerCase(), label)
    }
  }
  return labels.size ? [...labels.values()].join(' · ') : null
}

function urlLabel(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null
    }
    return `${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

export function getWorkspaceAttachmentSourceLabel(item: WorkspaceAttachment): string | null {
  const source = item.taskSourceContext?.provider === item.provider ? item.taskSourceContext : null
  const identity = source?.providerIdentity
  if (item.provider === 'linear') {
    const organization =
      item.linearOrganizationUrlKey ??
      (item.url ? parseLinearIssueInput(item.url)?.organizationUrlKey : null)
    return joinSourceParts(
      identity?.provider === 'linear' ? identity.workspaceName : null,
      organization,
      source?.accountLabel
    )
  }
  if (item.provider === 'jira') {
    const parsed = item.url ? parseJiraIssueUrl(item.url) : null
    return joinSourceParts(
      urlLabel(
        identity?.provider === 'jira' && identity.siteUrl
          ? identity.siteUrl
          : parsed
            ? `${parsed.origin}${parsed.sitePath}`
            : null
      ),
      source?.accountLabel
    )
  }
  if (item.provider === 'github') {
    const repo =
      (item.url ? parseGitHubIssueOrPRLink(item.url)?.slug : null) ??
      (identity?.provider === 'github' ? identity : null)
    if (repo) {
      const host = repo.host && repo.host.toLowerCase() !== 'github.com' ? `${repo.host}/` : ''
      return `${host}${repo.owner}/${repo.repo}`
    }
  }
  if (item.provider === 'gitlab') {
    const parsed = item.url ? parseGitLabIssueOrMRLink(item.url) : null
    if (parsed) {
      return `${parsed.slug.host}/${parsed.slug.path}`
    }
    if (identity?.provider === 'gitlab') {
      return (
        urlLabel(identity.webUrl) ??
        (identity.namespace && identity.project
          ? `${identity.namespace}/${identity.project}`
          : null)
      )
    }
  }
  return urlLabel(getWorkspaceAttachmentUrlScope(item))
}
