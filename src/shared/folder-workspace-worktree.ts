import type { FolderWorkspace, Worktree } from './types'
import { folderWorkspaceKey } from './workspace-scope'
import { parseExecutionHostId, toSshExecutionHostId } from './execution-host'
import { normalizeWorkspaceCreatorProvenance } from './workspace-creator-provenance'

// Synthetic repoId a folder workspace carries in place of a real git repo id.
// Encodes its owning project group so consumers can recover group membership.
export function folderWorkspaceRepoId(projectGroupId: string): string {
  return `folder-workspace:${projectGroupId}`
}

export function folderWorkspaceToWorktree(folderWorkspace: FolderWorkspace): Worktree {
  const linkedTask = folderWorkspace.linkedTask
  const creatorProvenance = normalizeWorkspaceCreatorProvenance(folderWorkspace.creatorProvenance)
  const hostId =
    folderWorkspace.executionHostId ??
    (folderWorkspace.connectionId ? toSshExecutionHostId(folderWorkspace.connectionId) : 'local')
  const parsedHost = parseExecutionHostId(hostId)
  return {
    id: folderWorkspaceKey(folderWorkspace.id),
    repoId: folderWorkspaceRepoId(folderWorkspace.projectGroupId),
    ...(creatorProvenance ? { creatorProvenance } : {}),
    displayName: folderWorkspace.name,
    comment: folderWorkspace.comment,
    linkedIssue:
      linkedTask?.provider === 'github' && linkedTask.type === 'issue' ? linkedTask.number : null,
    linkedPR: null,
    linkedLinearIssue:
      linkedTask?.provider === 'linear' ? (linkedTask.linearIdentifier ?? null) : null,
    linkedGitLabMR: null,
    linkedGitLabIssue:
      linkedTask?.provider === 'gitlab' && linkedTask.type === 'issue' ? linkedTask.number : null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: linkedTask,
    linkedTaskSourceContext: folderWorkspace.linkedTaskSourceContext ?? null,
    isArchived: folderWorkspace.isArchived,
    isUnread: folderWorkspace.isUnread,
    isPinned: folderWorkspace.isPinned,
    sortOrder: folderWorkspace.sortOrder,
    manualOrder: folderWorkspace.manualOrder,
    lastActivityAt: folderWorkspace.lastActivityAt,
    createdAt: folderWorkspace.createdAt,
    createdWithAgent: folderWorkspace.createdWithAgent,
    pendingFirstAgentMessageRename: folderWorkspace.pendingFirstAgentMessageRename,
    firstAgentMessageRenameError: folderWorkspace.firstAgentMessageRenameError,
    workspaceStatus: folderWorkspace.workspaceStatus,
    path: folderWorkspace.folderPath,
    head: '',
    branch: '',
    isBare: false,
    isSparse: false,
    isMainWorktree: false,
    hostId,
    ...(parsedHost?.kind === 'runtime'
      ? { runtimeOwnerEnvironmentId: parsedHost.environmentId }
      : {})
  }
}
