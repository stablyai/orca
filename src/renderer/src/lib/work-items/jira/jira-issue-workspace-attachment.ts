import type { JiraIssue, JiraSite } from '../../../../../shared/jira/jira-types'
import {
  getMatchingJiraSites,
  parseJiraIssueUrl,
  JIRA_ISSUE_KEY_PATTERN
} from '../../../../../shared/jira/jira-issue-url'
import { getWorkspaceAttachments } from '../../../../../shared/workspace-attachments/workspace-attachments'
import type { WorkspaceAttachment, Worktree } from '../../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import { getPaletteWorktreeExecutionHostId } from '@/lib/workspace/search/palette-repo-resolution'

export type JiraIssueWorkspaceAttachmentIndex = ReadonlyMap<string, readonly Worktree[]>
export type LinkedJiraIssueRef = { key: string; siteId: string; sourceContext?: TaskSourceContext }

function jiraKey(item: WorkspaceAttachment): string | null {
  if (item.provider !== 'jira') {
    return null
  }
  const value = (item.identifier ?? item.jiraIdentifier ?? '').trim()
  return JIRA_ISSUE_KEY_PATTERN.test(value)
    ? value.toUpperCase()
    : (parseJiraIssueUrl(value)?.issueKey ?? null)
}

// Why: links without a taskSourceContext (from `orca reference add`) come from their workspace's
// runtime Jira; SSH workspaces have no Jira of their own, so they fall back to the desktop.
function workspaceSourceHostId(workspace: Worktree): ExecutionHostId {
  const host = parseExecutionHostId(getPaletteWorktreeExecutionHostId(workspace))
  return host?.kind === 'runtime' ? host.id : LOCAL_EXECUTION_HOST_ID
}

// Why host only: the login is matched by siteId below and the label is display-only.
function sameSource(
  item: WorkspaceAttachment,
  source: TaskSourceContext | null | undefined,
  fallbackHostId: ExecutionHostId
): boolean {
  return !source || (item.taskSourceContext?.hostId ?? fallbackHostId) === source.hostId
}

function itemSite(item: WorkspaceAttachment) {
  const identity = item.taskSourceContext?.providerIdentity
  const jiraIdentity = identity?.provider === 'jira' ? identity : null
  const parsed =
    parseJiraIssueUrl(item.url ?? '') ??
    (jiraIdentity?.siteUrl
      ? parseJiraIssueUrl(`${jiraIdentity.siteUrl.replace(/\/+$/, '')}/browse/${jiraKey(item)}`)
      : null)
  return { identity: jiraIdentity, parsed }
}

export function jiraAttachmentMatchesIssue(
  item: WorkspaceAttachment,
  issue: JiraIssue,
  source?: TaskSourceContext | null,
  fallbackHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): boolean {
  if (jiraKey(item) !== issue.key.toUpperCase() || !sameSource(item, source, fallbackHostId)) {
    return false
  }
  const { identity, parsed } = itemSite(item)
  const issueSite = parseJiraIssueUrl(issue.url)
  if (
    identity?.projectKey &&
    identity.projectKey.toUpperCase() !== issue.project.key.toUpperCase()
  ) {
    return false
  }
  if (identity?.siteId && issue.siteId && identity.siteId !== issue.siteId) {
    return false
  }
  if (parsed && issueSite) {
    return parsed.origin === issueSite.origin && parsed.sitePath === issueSite.sitePath
  }
  return Boolean(identity?.siteId && identity.siteId === issue.siteId)
}

export function buildJiraIssueWorkspaceAttachmentIndex(
  workspaces: readonly Worktree[]
): JiraIssueWorkspaceAttachmentIndex {
  const index = new Map<string, Worktree[]>()
  for (const workspace of workspaces) {
    if (workspace.isArchived) {
      continue
    }
    const keys = new Set(getWorkspaceAttachments(workspace).map(jiraKey))
    for (const key of keys) {
      if (!key) {
        continue
      }
      const bucket = index.get(key)
      if (bucket) {
        bucket.push(workspace)
      } else {
        index.set(key, [workspace])
      }
    }
  }
  return index
}

export function findJiraIssueWorkspaceAttachmentsInIndex(
  index: JiraIssueWorkspaceAttachmentIndex,
  issue: JiraIssue,
  source?: TaskSourceContext | null
): readonly Worktree[] {
  return (index.get(issue.key.toUpperCase()) ?? [])
    .filter((workspace) => {
      const fallbackHostId = workspaceSourceHostId(workspace)
      return getWorkspaceAttachments(workspace).some((item) =>
        jiraAttachmentMatchesIssue(item, issue, source, fallbackHostId)
      )
    })
    .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
}

export function collectLinkedJiraIssueRefs(
  workspaces: readonly Worktree[],
  sites: readonly JiraSite[],
  selectedSiteId: string | null | undefined,
  source?: TaskSourceContext | null
): LinkedJiraIssueRef[] {
  const refs = new Map<string, LinkedJiraIssueRef>()
  for (const workspace of workspaces) {
    if (workspace.isArchived) {
      continue
    }
    const fallbackHostId = workspaceSourceHostId(workspace)
    for (const item of getWorkspaceAttachments(workspace)) {
      const key = jiraKey(item)
      if (!key || !sameSource(item, source, fallbackHostId)) {
        continue
      }
      const { identity, parsed } = itemSite(item)
      const matches = parsed
        ? getMatchingJiraSites(parsed, sites)
        : sites.filter((site) => site.id === identity?.siteId)
      const candidates = matches.filter(
        (candidate) =>
          (!identity?.siteId || identity.siteId === candidate.id) &&
          (!selectedSiteId || selectedSiteId === 'all' || selectedSiteId === candidate.id)
      )
      const site = candidates.length === 1 ? candidates[0] : null
      if (
        !site ||
        (identity?.projectKey && !key.startsWith(`${identity.projectKey.toUpperCase()}-`))
      ) {
        continue
      }
      refs.set(`${site.id}:${key}`, {
        key,
        siteId: site.id,
        ...(item.taskSourceContext ? { sourceContext: item.taskSourceContext } : {})
      })
    }
  }
  return [...refs.values()].toSorted((a, b) =>
    `${a.siteId}:${a.key}`.localeCompare(`${b.siteId}:${b.key}`)
  )
}
