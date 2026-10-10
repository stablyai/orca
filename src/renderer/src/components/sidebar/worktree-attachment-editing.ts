import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import type { WorkspaceAttachmentMutation } from '../../../../shared/workspace-attachment-mutation'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import { normalizeGitRemoteUrl } from '../../../../shared/git-remote-identity'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import {
  getWorkspaceAttachmentKey,
  getWorkspaceAttachmentUrlScope
} from '../../../../shared/workspace-attachment-normalization'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { parseGitLabIssueOrMRLink } from '../../../../shared/new-workspace/gitlab-links'
import { parseLinearIssueInput } from '../../../../shared/linear/links'
import { parseJiraIssueUrl } from '../../../../shared/jira-issue-url'
import { isWorkItemLinkQueryTooLarge } from '../../../../shared/new-workspace/work-item-link-query-bounds'

export const ATTACHMENT_INPUT_KINDS = [
  { value: 'github-pr', label: () => translate('workspace.links.kind.github_pr', 'GitHub PR') },
  {
    value: 'github-issue',
    label: () => translate('workspace.links.kind.github_issue', 'GitHub issue')
  },
  {
    value: 'linear-issue',
    label: () => translate('workspace.links.kind.linear_task', 'Linear task')
  },
  { value: 'gitlab-mr', label: () => translate('workspace.links.kind.gitlab_mr', 'GitLab MR') },
  {
    value: 'gitlab-issue',
    label: () => translate('workspace.links.kind.gitlab_issue', 'GitLab issue')
  },
  {
    value: 'jira-issue',
    label: () => translate('workspace.links.kind.jira_task_url', 'Jira task (URL)')
  },
  {
    value: 'bitbucket-pr',
    label: () => translate('workspace.links.kind.bitbucket_pr', 'Bitbucket PR')
  },
  {
    value: 'azure-devops-pr',
    label: () => translate('workspace.links.kind.azure_devops_pr', 'Azure DevOps PR')
  },
  { value: 'gitea-pr', label: () => translate('workspace.links.kind.gitea_pr', 'Gitea PR') }
] as const
export type AttachmentInputKind = (typeof ATTACHMENT_INPUT_KINDS)[number]['value']

export function isAttachmentInputKind(value: string): value is AttachmentInputKind {
  return ATTACHMENT_INPUT_KINDS.some((kind) => kind.value === value)
}

export function workspaceAttachmentProviderLabel(item: WorkspaceAttachment): string {
  const labels = {
    github: 'GitHub',
    gitlab: 'GitLab',
    linear: 'Linear',
    jira: 'Jira',
    bitbucket: 'Bitbucket',
    'azure-devops': 'Azure DevOps',
    gitea: 'Gitea'
  }
  return labels[item.provider]
}

export function workspaceAttachmentLabel(item: WorkspaceAttachment): string {
  if (item.provider === 'linear' || item.provider === 'jira') {
    return item.identifier ?? item.linearIdentifier ?? item.jiraIdentifier ?? `#${item.number}`
  }
  if (item.type === 'mr') {
    return translate('workspace.links.mrReference', 'MR !{{number}}', { number: item.number })
  }
  if (item.type === 'pr') {
    return translate('workspace.links.prReference', 'PR #{{number}}', { number: item.number })
  }
  return translate('workspace.links.issueReference', 'Issue #{{number}}', { number: item.number })
}

export function parseWorkspaceAttachmentInput(
  input: string,
  kind: AttachmentInputKind
): WorkspaceAttachment | null {
  const value = input.trim()
  if (!value || isWorkItemLinkQueryTooLarge(value)) {
    return null
  }
  const github = parseGitHubIssueOrPRLink(value)
  const gitlab = parseGitLabIssueOrMRLink(value)
  const jira = parseJiraIssueUrl(value)
  const linear = parseLinearIssueInput(value)
  if (/^https?:\/\//i.test(value)) {
    const otherReview = parseOtherReviewUrl(value)
    if (otherReview) {
      return otherReview
    }
    if (github) {
      return { provider: 'github', type: github.type, number: github.number, url: value }
    }
    if (gitlab && Number.isSafeInteger(gitlab.number) && gitlab.number > 0) {
      return { provider: 'gitlab', type: gitlab.type, number: gitlab.number, url: value }
    }
    if (jira) {
      return {
        provider: 'jira',
        type: 'issue',
        number: 0,
        identifier: jira.issueKey,
        jiraIdentifier: jira.issueKey,
        url: value
      }
    }
    if (linear) {
      return {
        provider: 'linear',
        type: 'issue',
        number: 0,
        identifier: linear.identifier,
        linearIdentifier: linear.identifier,
        url: value,
        linearOrganizationUrlKey: linear.organizationUrlKey
      }
    }
    return null
  }
  if (kind === 'linear-issue') {
    return linear
      ? {
          provider: 'linear',
          type: 'issue',
          number: 0,
          identifier: linear.identifier,
          linearIdentifier: linear.identifier
        }
      : null
  }
  if (kind === 'jira-issue') {
    return null
  }
  const number = Number(value.replace(/^[#!]/, ''))
  if (!/^[#!]?\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    return null
  }
  if (kind === 'gitlab-mr' || kind === 'gitlab-issue') {
    return { provider: 'gitlab', type: kind === 'gitlab-mr' ? 'mr' : 'issue', number }
  }
  if (kind === 'bitbucket-pr' || kind === 'azure-devops-pr' || kind === 'gitea-pr') {
    const provider =
      kind === 'bitbucket-pr' ? 'bitbucket' : kind === 'gitea-pr' ? 'gitea' : 'azure-devops'
    return { provider, type: 'pr', number }
  }
  return { provider: 'github', type: kind === 'github-pr' ? 'pr' : 'issue', number }
}

export function buildWorkspaceAttachmentEdits({
  initial,
  draft
}: {
  initial: readonly WorkspaceAttachment[]
  draft: readonly WorkspaceAttachment[]
}): Partial<WorktreeMeta> & WorkspaceAttachmentMutation {
  return JSON.stringify(initial) === JSON.stringify(draft)
    ? {}
    : { linkedItemsBase: [...initial], linkedItems: [...draft] }
}

export function getActiveWorkspaceReviewKey(worktree: Worktree | undefined): string | null {
  if (!worktree) {
    return null
  }
  const active = getWorkspaceAttachments(worktree).find((item) =>
    item.provider === 'github' && item.type === 'pr'
      ? worktree.linkedPR === item.number
      : item.provider === 'gitlab' && item.type === 'mr'
        ? worktree.linkedGitLabMR === item.number
        : item.provider === 'bitbucket'
          ? worktree.linkedBitbucketPR === item.number
          : item.provider === 'azure-devops'
            ? worktree.linkedAzureDevOpsPR === item.number
            : item.provider === 'gitea'
              ? worktree.linkedGiteaPR === item.number
              : false
  )
  return active ? getWorkspaceAttachmentKey(active) : null
}

function parseOtherReviewUrl(value: string): WorkspaceAttachment | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username || url.password) {
    return null
  }
  const match = /\/(pull-requests|pullrequest|pulls)\/(\d+)\/?$/.exec(url.pathname)
  if (!match) {
    return null
  }
  const number = Number(match[2])
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null
  }
  const provider =
    match[1] === 'pull-requests'
      ? 'bitbucket'
      : match[1] === 'pullrequest'
        ? 'azure-devops'
        : 'gitea'
  return { provider, type: 'pr', number, url: value }
}

export function canUseWorkspaceReviewForChecks(
  item: WorkspaceAttachment,
  repo: Repo | undefined,
  knownProvider?: HostedReviewProvider
): boolean {
  if (item.type === 'issue') {
    return false
  }
  const host = repo?.gitRemoteIdentity?.canonicalKey.split('/')[0].toLowerCase()
  const provider =
    knownProvider ??
    (host === 'github.com'
      ? 'github'
      : host === 'gitlab.com'
        ? 'gitlab'
        : host === 'bitbucket.org'
          ? 'bitbucket'
          : host === 'dev.azure.com' ||
              host === 'ssh.dev.azure.com' ||
              host?.endsWith('.visualstudio.com')
            ? 'azure-devops'
            : host === 'codeberg.org'
              ? 'gitea'
              : undefined)
  if (provider && item.provider !== provider) {
    return false
  }
  return (
    (!item.url ? provider === item.provider : true) && isWorkspaceRepositoryAttachment(item, repo)
  )
}

export function isWorkspaceRepositoryAttachment(
  item: WorkspaceAttachment,
  repo: Repo | undefined
): boolean {
  if (!item.url) {
    return true
  }
  const remoteKey = repo?.gitRemoteIdentity?.canonicalKey
  if (!remoteKey) {
    return false
  }
  try {
    return normalizeGitRemoteUrl(getWorkspaceAttachmentUrlScope(item)) === remoteKey
  } catch {
    return false
  }
}
