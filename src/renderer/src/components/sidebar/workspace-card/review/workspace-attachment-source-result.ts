import { parseClickUpTaskReference } from '../../../../../../shared/clickup/clickup-task-reference'
import { getWorkspaceReferenceIdentity } from '../../../../../../shared/workspace-attachments/workspace-reference-identity'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorkspaceAttachment, Worktree } from '../../../../../../shared/worktree/types'
import {
  buildTaskSourceContextFromRepo,
  haveConflictingTaskSourceAccounts,
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../../../shared/work-items/task-source-context'
import type { TaskProvider } from '../../../../../../shared/work-items/task-providers'
import {
  getWorkspaceAttachmentUrlScope,
  matchesWorkspaceAttachmentIdentity,
  normalizeWorkspaceAttachments
} from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import { matchesClickUpWorkspaceReference } from './workspace-reference-details'

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

/** A fetched ClickUp row lists its task by raw-id URL, so a custom-id query matches through the task, not through URL scope. */
function matchesClickUpQueryResult(
  query: WorkspaceAttachment,
  result: WorkspaceAttachment
): boolean {
  const identifier = query.clickupIdentifier
  const resultIdentifier = result.clickupIdentifier
    ? parseClickUpTaskReference(result.clickupIdentifier)
    : null
  const resultUrl = result.url ? parseClickUpTaskReference(result.url) : null
  const resultIdentity = result.taskSourceContext?.providerIdentity
  if (!identifier || !result.url) {
    return false
  }
  return matchesClickUpWorkspaceReference(query, identifier, {
    id:
      resultUrl?.kind === 'id'
        ? resultUrl.id
        : resultIdentifier?.kind === 'id'
          ? resultIdentifier.id
          : '',
    customId: resultIdentifier?.kind === 'custom-id' ? resultIdentifier.customId : null,
    url: result.url,
    workspaceId: (resultIdentity?.provider === 'clickup' ? resultIdentity.workspaceId : null) ?? ''
  })
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
  if (query.provider === 'clickup') {
    return matchesClickUpQueryResult(query, result)
  }
  const identifier =
    query.identifier ?? query.linearIdentifier ?? query.jiraIdentifier ?? query.clickupIdentifier
  const resultIdentifier =
    result.identifier ??
    result.linearIdentifier ??
    result.jiraIdentifier ??
    result.clickupIdentifier
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
      (item.identifier ??
        item.linearIdentifier ??
        item.jiraIdentifier ??
        item.clickupIdentifier) ===
        (candidate.identifier ??
          candidate.linearIdentifier ??
          candidate.jiraIdentifier ??
          candidate.clickupIdentifier)
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
        !haveConflictingTaskSourceAccounts(oldContext, newContext))
    )
  })
}

export function appendWorkspaceAttachment(
  items: readonly WorkspaceAttachment[],
  item: WorkspaceAttachment
): WorkspaceAttachment[] {
  return normalizeWorkspaceAttachments([...items, item])
}
