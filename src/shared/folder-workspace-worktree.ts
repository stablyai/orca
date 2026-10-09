import type { FolderWorkspace } from './folder-workspace-types'
import type { Worktree } from './worktree/types'
import { folderWorkspaceKey } from './workspace-scope'
import { parseExecutionHostId, toSshExecutionHostId, type ExecutionHostId } from './execution-host'
import { composeWorktreeHostIdentity } from './worktree/host-qualified-identity'
import { normalizeWorkspaceCreatorProvenance } from './workspace-creator-provenance'
import { getWorkspaceAttachments } from './workspace-attachments'
import { normalizeWorkspaceAttachment } from './workspace-attachment-normalization'

/**
 * A folder workspace has no git repo, so its synthetic `Worktree` borrows the `repoId` slot to
 * name the PROJECT GROUP it belongs to. The value is never null, so a caller testing `repoId` for
 * absence to detect "no repo" will be wrong for every folder workspace.
 *
 * Minting and recognising it live together here so the two cannot drift.
 */
const FOLDER_WORKSPACE_REPO_ID_PREFIX = 'folder-workspace:'

export function folderWorkspaceRepoId(projectGroupId: string): string {
  return `${FOLDER_WORKSPACE_REPO_ID_PREFIX}${projectGroupId}`
}

/** The project group a synthetic repoId stands for, or null when it names a real git repo. */
export function projectGroupIdFromRepoId(repoId: string | null | undefined): string | null {
  if (typeof repoId !== 'string' || !repoId.startsWith(FOLDER_WORKSPACE_REPO_ID_PREFIX)) {
    return null
  }
  const projectGroupId = repoId.slice(FOLDER_WORKSPACE_REPO_ID_PREFIX.length)
  return projectGroupId === '' ? null : projectGroupId
}

function getFolderWorkspaceWorktreeHostId(
  workspace: Pick<FolderWorkspace, 'executionHostId' | 'connectionId'>
): ExecutionHostId {
  return (
    workspace.executionHostId ??
    (workspace.connectionId ? toSshExecutionHostId(workspace.connectionId) : 'local')
  )
}

export function getFolderWorkspaceHostIdentity(
  workspace: Pick<FolderWorkspace, 'id' | 'executionHostId' | 'connectionId'>
): string {
  return composeWorktreeHostIdentity(
    getFolderWorkspaceWorktreeHostId(workspace),
    folderWorkspaceKey(workspace.id)
  )
}

export function folderWorkspaceToWorktree(folderWorkspace: FolderWorkspace): Worktree {
  const linkedTask = folderWorkspace.linkedTask
  const selectedTask = linkedTask
    ? normalizeWorkspaceAttachment(linkedTask)
    : getWorkspaceAttachments({
        linkedItems: folderWorkspace.linkedItems
      }).find((item) => item.type === 'issue')
  const creatorProvenance = normalizeWorkspaceCreatorProvenance(folderWorkspace.creatorProvenance)
  const hostId = getFolderWorkspaceWorktreeHostId(folderWorkspace)
  const parsedHost = parseExecutionHostId(hostId)
  return {
    id: folderWorkspaceKey(folderWorkspace.id),
    repoId: folderWorkspaceRepoId(folderWorkspace.projectGroupId),
    ...(creatorProvenance ? { creatorProvenance } : {}),
    displayName: folderWorkspace.name,
    comment: folderWorkspace.comment,
    linkedIssue:
      selectedTask?.provider === 'github' && selectedTask.type === 'issue'
        ? selectedTask.number
        : null,
    linkedPR: null,
    linkedLinearIssue:
      selectedTask?.provider === 'linear'
        ? (selectedTask.identifier ?? selectedTask.linearIdentifier ?? null)
        : null,
    linkedLinearIssueWorkspaceId:
      selectedTask?.provider === 'linear' ? (selectedTask.linearWorkspaceId ?? null) : null,
    linkedLinearIssueOrganizationUrlKey:
      selectedTask?.provider === 'linear' ? (selectedTask.linearOrganizationUrlKey ?? null) : null,
    linkedGitLabMR: null,
    linkedGitLabIssue:
      selectedTask?.provider === 'gitlab' && selectedTask.type === 'issue'
        ? selectedTask.number
        : null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: linkedTask,
    ...(folderWorkspace.linkedItems !== undefined
      ? { linkedItems: folderWorkspace.linkedItems }
      : {}),
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
    diffComments: folderWorkspace.diffComments,
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
