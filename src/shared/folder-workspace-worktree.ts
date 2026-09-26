import type { FolderWorkspace } from './folder-workspace-types'
import type { Worktree } from './worktree/types'
import { folderWorkspaceKey } from './workspace-scope'
import { parseExecutionHostId, toSshExecutionHostId } from './execution-host'
import { normalizeWorkspaceCreatorProvenance } from './workspace-creator-provenance'

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
    ...(folderWorkspace.tags !== undefined ? { tags: folderWorkspace.tags } : {}),
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
