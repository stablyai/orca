import type { FolderWorkspace, Worktree } from './types'
import { folderWorkspaceKey } from './workspace-scope'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'

type FolderWorktreeOwner = Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>

function getConnectionHostId(connectionId: string | null | undefined): ExecutionHostId | null {
  if (connectionId === null) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const normalized = connectionId?.trim()
  return normalized ? toSshExecutionHostId(normalized) : null
}

function getFolderWorktreeOwner(folderWorkspace: FolderWorkspace): FolderWorktreeOwner {
  const rawExecutionHostId = folderWorkspace.executionHostId
  const executionHost = parseExecutionHostId(rawExecutionHostId)
  const rawSourceHostId = folderWorkspace.runtimeSourceExecutionHostId
  const sourceHost = parseExecutionHostId(rawSourceHostId)
  const connectionHostId = getConnectionHostId(folderWorkspace.connectionId)
  if (
    (rawExecutionHostId != null && !executionHost) ||
    (rawSourceHostId != null && !sourceHost) ||
    (folderWorkspace.connectionId !== undefined && !connectionHostId)
  ) {
    return {}
  }

  const physicalHostIds = new Set<ExecutionHostId>()
  if (sourceHost) {
    physicalHostIds.add(sourceHost.id)
  }
  if (connectionHostId) {
    physicalHostIds.add(connectionHostId)
  }
  if (executionHost?.kind !== 'runtime' && executionHost) {
    physicalHostIds.add(executionHost.id)
  }
  if (physicalHostIds.size > 1) {
    return {}
  }

  if (executionHost?.kind === 'runtime') {
    const hostId = physicalHostIds.values().next().value as ExecutionHostId | undefined
    return hostId
      ? { hostId, runtimeOwnerEnvironmentId: executionHost.environmentId }
      : { runtimeOwnerEnvironmentId: executionHost.environmentId }
  }
  const hostId =
    (physicalHostIds.values().next().value as ExecutionHostId | undefined) ??
    LOCAL_EXECUTION_HOST_ID
  return { hostId }
}

export function folderWorkspaceToWorktree(folderWorkspace: FolderWorkspace): Worktree {
  const linkedTask = folderWorkspace.linkedTask
  const owner = getFolderWorktreeOwner(folderWorkspace)
  return {
    id: folderWorkspaceKey(folderWorkspace.id),
    repoId: `folder-workspace:${folderWorkspace.projectGroupId}`,
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
    ...owner
  }
}
