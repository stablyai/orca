import type { AppState } from '../../../types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import { findWorktreeById, withoutErasedRequiredWorktreeFields } from '../../worktree-helpers'
import { worktreeMatchesHost } from './worktree-host-ownership'

const folderWorkspaceWorktreeCache = new WeakMap<FolderWorkspace, Worktree>()

import { worktreeRowMatchesMetaHost } from './worktree-meta-host-match'

export function applyDetectedWorktreeUpdates(
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo'],
  worktreeId: string,
  rawUpdates: Partial<WorktreeMeta>,
  executionHostId?: ExecutionHostId
): AppState['detectedWorktreesByRepo'] {
  // Why: mirrors applyWorktreeUpdates — detected rows feed the same palette.
  const updates = withoutErasedRequiredWorktreeFields(rawUpdates)
  let changed = false
  const nextByRepo: AppState['detectedWorktreesByRepo'] = {}

  for (const [repoId, result] of Object.entries(detectedWorktreesByRepo)) {
    let repoChanged = false
    const nextWorktrees = result.worktrees.map((worktree) => {
      if (worktree.id !== worktreeId || !worktreeRowMatchesMetaHost(worktree, executionHostId)) {
        return worktree
      }
      repoChanged = true
      changed = true
      return { ...worktree, ...updates }
    })
    nextByRepo[repoId] = repoChanged ? { ...result, worktrees: nextWorktrees } : result
  }

  return changed ? nextByRepo : detectedWorktreesByRepo
}

export function folderWorkspaceMatchesHost(
  workspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  executionHostId: ExecutionHostId
): boolean {
  return (
    (parseExecutionHostId(workspace.executionHostId)?.id ??
      (workspace.connectionId?.trim()
        ? toSshExecutionHostId(workspace.connectionId)
        : LOCAL_EXECUTION_HOST_ID)) === executionHostId
  )
}

export function findKnownWorktreeById(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces'>,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspace = state.folderWorkspaces.find(
      (workspace) =>
        workspace.id === workspaceScope.folderWorkspaceId &&
        (!executionHostId || folderWorkspaceMatchesHost(workspace, executionHostId))
    )
    if (!folderWorkspace) {
      return undefined
    }
    const cached = folderWorkspaceWorktreeCache.get(folderWorkspace)
    if (cached) {
      return cached
    }
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    folderWorkspaceWorktreeCache.set(folderWorkspace, worktree)
    return worktree
  }
  const visible = executionHostId
    ? (findIndexedWorktreeOwnerForHost(
        state.worktreesByRepo,
        worktreeId,
        executionHostId
      ) as Worktree | null)
    : findWorktreeById(state.worktreesByRepo, worktreeId)
  if (visible) {
    return visible
  }
  for (const result of Object.values(state.detectedWorktreesByRepo)) {
    const detected = result.worktrees.find(
      (worktree) =>
        worktree.id === worktreeId &&
        (!executionHostId ||
          worktreeMatchesHost(worktree, executionHostId, {
            unhostedWorktreesMatchHost: executionHostId === LOCAL_EXECUTION_HOST_ID
          }))
    )
    if (detected) {
      return detected
    }
  }
  return undefined
}

export function getFolderWorkspaceMetaUpdates(
  updates: Partial<WorktreeMeta>
): Partial<
  Pick<
    FolderWorkspace,
    | 'name'
    | 'comment'
    | 'isArchived'
    | 'isUnread'
    | 'isPinned'
    | 'sortOrder'
    | 'manualOrder'
    | 'lastActivityAt'
    | 'workspaceStatus'
    | 'createdWithAgent'
    | 'pendingFirstAgentMessageRename'
    | 'firstAgentMessageRenameError'
    | 'diffComments'
  >
> {
  const next: Partial<
    Pick<
      FolderWorkspace,
      | 'name'
      | 'comment'
      | 'isArchived'
      | 'isUnread'
      | 'isPinned'
      | 'sortOrder'
      | 'manualOrder'
      | 'lastActivityAt'
      | 'workspaceStatus'
      | 'createdWithAgent'
      | 'pendingFirstAgentMessageRename'
      | 'firstAgentMessageRenameError'
      | 'diffComments'
    >
  > = {}
  if (updates.displayName !== undefined) {
    next.name = updates.displayName
    next.pendingFirstAgentMessageRename = false
    next.firstAgentMessageRenameError = null
  }
  if (updates.comment !== undefined) {
    next.comment = updates.comment
    next.lastActivityAt = Date.now()
  }
  if (updates.isArchived !== undefined) {
    next.isArchived = updates.isArchived
  }
  if (updates.isUnread !== undefined) {
    next.isUnread = updates.isUnread
  }
  if (updates.isPinned !== undefined) {
    next.isPinned = updates.isPinned
  }
  if (updates.sortOrder !== undefined) {
    next.sortOrder = updates.sortOrder
  }
  if (updates.manualOrder !== undefined) {
    next.manualOrder = updates.manualOrder
  }
  if (updates.lastActivityAt !== undefined) {
    next.lastActivityAt = updates.lastActivityAt
  }
  if (updates.workspaceStatus !== undefined) {
    next.workspaceStatus = updates.workspaceStatus
  }
  if (updates.createdWithAgent !== undefined) {
    next.createdWithAgent = updates.createdWithAgent
  }
  if (updates.pendingFirstAgentMessageRename !== undefined) {
    next.pendingFirstAgentMessageRename = updates.pendingFirstAgentMessageRename
  }
  if (updates.firstAgentMessageRenameError !== undefined) {
    next.firstAgentMessageRenameError = updates.firstAgentMessageRenameError
  }
  if (updates.diffComments !== undefined) {
    next.diffComments = updates.diffComments
  }
  return next
}
