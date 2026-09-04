import type { AppState } from '../../../types'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
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
import {
  findIndexedDetectedWorktrees,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import { findWorktreeById, withoutErasedRequiredWorktreeFields } from '../../worktree-helpers'
import { worktreeMatchesHost } from './worktree-host-ownership'

const folderWorkspaceWorktreeCache = new WeakMap<FolderWorkspace, Worktree>()

import { worktreeRowMatchesMetaHost } from './worktree-meta-host-match'
import { branchName } from '@/lib/git-utils'

export function applyDetectedWorktreeUpdates(
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo'],
  worktreeId: string,
  rawUpdates: Partial<WorktreeMeta>,
  executionHostId?: ExecutionHostId,
  identityKey?: string,
  runtimeOwnerEnvironmentId?: string | null
): AppState['detectedWorktreesByRepo'] {
  // Why: mirrors applyWorktreeUpdates — detected rows feed the same palette.
  const updates = withoutErasedRequiredWorktreeFields(rawUpdates)
  let changed = false
  const nextByRepo: AppState['detectedWorktreesByRepo'] = {}

  for (const [repoId, result] of Object.entries(detectedWorktreesByRepo)) {
    let repoChanged = false
    const nextWorktrees = result.worktrees.map((worktree) => {
      if (
        worktree.id !== worktreeId ||
        !worktreeRowMatchesMetaHost(worktree, executionHostId) ||
        (identityKey !== undefined && worktree.identity?.key !== identityKey) ||
        (runtimeOwnerEnvironmentId !== undefined &&
          (worktree.runtimeOwnerEnvironmentId ?? null) !== runtimeOwnerEnvironmentId)
      ) {
        return worktree
      }
      repoChanged = true
      changed = true
      const next = { ...worktree, ...updates }
      if (updates.displayNameIsPinned !== undefined) {
        next.displayNameMode = updates.displayNameIsPinned ? 'fixed' : 'automatic'
        if (updates.displayNameIsPinned === false && !updates.displayName?.trim()) {
          const automaticName = branchName(next.branch)
          next.displayName = automaticName || worktree.displayName
        }
      }
      return next
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

/**
 * The row for a canonical identity, or undefined without a key. Deliberately not filtered by the
 * requested id: a local folder rename retires the path-derived locator, and a write issued from
 * the still-visible old row must follow the identity to the row's current id rather than recreate
 * metadata under the retired one. The requested id only picks the repository to search.
 */
export function findKnownWorktreeByIdentityKey(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string,
  identityKey: string | undefined
): Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined {
  if (identityKey === undefined) {
    return undefined
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const visible = state.worktreesByRepo[repoId]?.find(
    (worktree) => worktree.identity?.key === identityKey
  )
  if (visible) {
    return visible
  }
  return state.detectedWorktreesByRepo[repoId]?.worktrees.find(
    (worktree) => worktree.identity?.key === identityKey
  )
}

/** What a caller uses to address one exact row: its identity, or its runtime owner before it has one. */
export type WorktreeMetaRowPin = { identityKey?: string; runtimeOwnerEnvironmentId?: string | null }

export function isPinnedWorktreeMetaUpdate(pin: WorktreeMetaRowPin | undefined): boolean {
  return pin?.identityKey !== undefined || pin?.runtimeOwnerEnvironmentId !== undefined
}

/**
 * The row a pinned write addresses. Identity wins when the caller knows it. An identity-less row is
 * picked by id, host, and runtime owner: two paired runtimes can publish one checkout as two rows
 * sharing id and host, and an id-and-host lookup would land on either. Undefined when nothing pins.
 */
export function findPinnedWorktreeRow(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces'>,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  pin: WorktreeMetaRowPin | undefined
): Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined {
  if (pin?.identityKey !== undefined) {
    return findKnownWorktreeByIdentityKey(state, worktreeId, pin.identityKey)
  }
  const owner = pin?.runtimeOwnerEnvironmentId
  if (owner === undefined) {
    return undefined
  }
  const ownsRow = (worktree: Worktree): boolean =>
    worktree.id === worktreeId &&
    // Why `?? null`: a `null` pin names the row the desktop lists itself, which carries no owner.
    (worktree.runtimeOwnerEnvironmentId ?? null) === owner &&
    worktreeRowMatchesMetaHost(worktree, executionHostId)
  // Why: a folder workspace published by a paired runtime projects that runtime as its owner and
  // lives in its own list; searching only the git catalogs rejected every such folder as gone.
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    const folder = findKnownWorktreeById(state, worktreeId, executionHostId)
    return folder && ownsRow(folder) ? folder : undefined
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return (
    state.worktreesByRepo[repoId]?.find(ownsRow) ??
    state.detectedWorktreesByRepo[repoId]?.worktrees.find(ownsRow)
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
  // Why the index: this miss path runs per activity row for exactly the worktrees the
  // feature targets (retained agents on deleted worktrees); the cached index replaces a
  // full scan of every repo's detected worktrees. The index holds the same row objects,
  // so the cast restores the listing's row type.
  const detectedCandidates = findIndexedDetectedWorktrees(
    state.detectedWorktreesByRepo,
    worktreeId
  ) as DetectedWorktreeListResult['worktrees']
  for (const detected of detectedCandidates) {
    if (
      !executionHostId ||
      worktreeMatchesHost(detected, executionHostId, {
        unhostedWorktreesMatchHost: executionHostId === LOCAL_EXECUTION_HOST_ID
      })
    ) {
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
    | 'colorTag'
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
      | 'colorTag'
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
  if (updates.colorTag !== undefined) {
    next.colorTag = updates.colorTag
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
