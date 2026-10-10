import { getWorkspaceReferenceIdentity } from '../../../../shared/workspace-reference-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import {
  buildTaskSourceContextFromRepo,
  normalizeTaskSourceContext,
  type TaskSourceContext,
  type TaskProvider
} from '../../../../shared/task-source-context'
import {
  getWorkspaceAttachmentUrlScope,
  matchesWorkspaceAttachmentIdentity,
  normalizeWorkspaceAttachments
} from '../../../../shared/workspace-attachment-normalization'

export function getWorkspaceAttachmentSourceContext(
  provider: TaskProvider,
  repo: Repo | undefined,
  workspace: Worktree | undefined
): TaskSourceContext | null {
  const stored = workspace?.linkedTaskSourceContext
  if (stored?.provider === provider) {
    return stored
  }
  if (repo) {
    return buildTaskSourceContextFromRepo({
      provider,
      projectId: workspace?.projectId ?? repo.id,
      repo: { ...repo, executionHostId: workspace?.hostId ?? repo.executionHostId },
      projectHostSetupId: workspace?.projectHostSetupId
    })
  }
  return workspace
    ? normalizeTaskSourceContext({
        provider,
        projectId: workspace.projectId ?? workspace.repoId,
        hostId: workspace.hostId,
        projectHostSetupId: workspace.projectHostSetupId
      })
    : null
}

export function matchesWorkspaceAttachmentQuery(
  query: WorkspaceAttachment,
  result: WorkspaceAttachment
): boolean {
  if (query.provider !== result.provider || query.number !== result.number) {
    return false
  }
  // GitHub issues and PRs share numbers; GitLab issues and MRs have separate sequences.
  if (query.type !== result.type && (query.provider !== 'github' || query.url)) {
    return false
  }
  const identifier = query.identifier ?? query.linearIdentifier ?? query.jiraIdentifier
  const resultIdentifier = result.identifier ?? result.linearIdentifier ?? result.jiraIdentifier
  if (identifier && identifier.toLowerCase() !== resultIdentifier?.toLowerCase()) {
    return false
  }
  return (
    !query.url || getWorkspaceAttachmentUrlScope(query) === getWorkspaceAttachmentUrlScope(result)
  )
}

export function isWorkspaceAttachmentLinked(
  items: readonly WorkspaceAttachment[],
  candidate: WorkspaceAttachment
): boolean {
  const identity = getWorkspaceReferenceIdentity(candidate)
  return items.some((item) => {
    if (
      getWorkspaceReferenceIdentity(item) === identity ||
      matchesWorkspaceAttachmentIdentity(candidate, item) ||
      matchesWorkspaceAttachmentIdentity(item, candidate)
    ) {
      return true
    }
    const sameReference =
      item.provider === candidate.provider &&
      item.type === candidate.type &&
      item.number === candidate.number &&
      (item.identifier ?? item.linearIdentifier ?? item.jiraIdentifier) ===
        (candidate.identifier ?? candidate.linearIdentifier ?? candidate.jiraIdentifier)
    const scope = getWorkspaceAttachmentUrlScope(item)
    if (!sameReference || !scope || scope !== getWorkspaceAttachmentUrlScope(candidate)) {
      return false
    }
    const oldContext = item.taskSourceContext
    const newContext = candidate.taskSourceContext
    return (
      !oldContext ||
      !newContext ||
      (oldContext.hostId === newContext.hostId &&
        oldContext.projectId === newContext.projectId &&
        (!oldContext.accountLabel ||
          !newContext.accountLabel ||
          oldContext.accountLabel === newContext.accountLabel))
    )
  })
}

export function appendWorkspaceAttachment(
  items: readonly WorkspaceAttachment[],
  item: WorkspaceAttachment
): WorkspaceAttachment[] {
  return normalizeWorkspaceAttachments([...items, item])
}
