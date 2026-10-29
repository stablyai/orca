import type { WorkspaceAttachmentMutation } from '../../../../../../shared/workspace-attachment-mutation'
import type { AppState } from '../../../types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import {
  floatingWorkspaceToWorktree,
  isFloatingWorkspaceId
} from '../../../../../../shared/floating-workspace-worktree'
import { findIndexedDetectedWorktrees } from '@/lib/worktree-runtime-owner-index'
import { findWorktreeById, withoutErasedRequiredWorktreeFields } from '../../worktree-helpers'
import { worktreeMatchesHost } from './worktree-host-ownership'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  selectFolderWorkspaces,
  selectWorkspaceByHostTarget,
  selectWorktreesByRepo
} from '../../../workspace-record-selectors'

const folderWorkspaceWorktreeCache = new WeakMap<FolderWorkspace, Worktree>()
// Singleton floating workspace needs one cached row while resolved cwd stays equal, preserving selector identity.
let floatingWorkspaceWorktreeCache: { path: string; worktree: Worktree } | null = null

import { worktreeRowMatchesMetaHost } from './worktree-meta-host-match'
import { branchName } from '@/lib/git-utils'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments'

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
      const next = { ...worktree, ...normalizeWorkspaceAttachmentUpdate(worktree, updates) }
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
  return getRepoExecutionHostId(workspace) === executionHostId
}

/** Stable synthetic row per folder workspace object, so selectors keep referential equality. */
export function getFolderWorkspaceWorktree(folderWorkspace: FolderWorkspace): Worktree {
  const cached = folderWorkspaceWorktreeCache.get(folderWorkspace)
  if (cached) {
    return cached
  }
  const worktree = folderWorkspaceToWorktree(folderWorkspace)
  folderWorkspaceWorktreeCache.set(folderWorkspace, worktree)
  return worktree
}

export function findKnownWorktreeById(
  state: Pick<
    AppState,
    'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces' | 'floatingWorkspacePath'
  >,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined {
  if (isFloatingWorkspaceId(worktreeId)) {
    // The floating workspace has no repo/folder row; mint the same synthetic row the host resolves
    // with, from the host-resolved directory. Before resolution there is no path to answer with.
    const path = state.floatingWorkspacePath
    if (!path || (executionHostId && executionHostId !== LOCAL_EXECUTION_HOST_ID)) {
      return undefined
    }
    if (floatingWorkspaceWorktreeCache?.path !== path) {
      floatingWorkspaceWorktreeCache = { path, worktree: floatingWorkspaceToWorktree(path) }
    }
    return floatingWorkspaceWorktreeCache.worktree
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspace = selectFolderWorkspaces(state).find(
      (workspace) =>
        workspace.id === workspaceScope.folderWorkspaceId &&
        (!executionHostId || folderWorkspaceMatchesHost(workspace, executionHostId))
    )
    return folderWorkspace ? getFolderWorkspaceWorktree(folderWorkspace) : undefined
  }
  const visible = executionHostId
    ? selectWorkspaceByHostTarget(
        state,
        hostWorktreeTarget({ id: worktreeId, hostId: executionHostId })
      )
    : findWorktreeById(selectWorktreesByRepo(state), worktreeId)
  if (visible) {
    return visible
  }
  // Cached index avoids fleet scans per deleted-worktree activity row; same row objects justify restoring the listing row type.
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
  updates: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
) {
  const next: Partial<FolderWorkspace> & WorkspaceAttachmentMutation = Object.fromEntries(
    (
      [
        'comment',
        'isArchived',
        'isUnread',
        'isPinned',
        'sortOrder',
        'manualOrder',
        'lastActivityAt',
        'workspaceStatus',
        'createdWithAgent',
        'pendingFirstAgentMessageRename',
        'firstAgentMessageRenameError',
        'diffComments',
        'linkedItems',
        'linkedItemsBase',
        'linkedItemsSelectionChanged',
        'linkedTaskSourceContext'
      ] as const
    )
      .filter((field) => updates[field] !== undefined)
      .map((field) => [field, updates[field]])
  )
  if (updates.displayName !== undefined) {
    next.name = updates.displayName
    next.pendingFirstAgentMessageRename = updates.pendingFirstAgentMessageRename ?? false
    next.firstAgentMessageRenameError =
      updates.firstAgentMessageRenameError === undefined
        ? null
        : updates.firstAgentMessageRenameError
  }
  if (
    updates.comment !== undefined &&
    updates.lastActivityAt === undefined &&
    !ORCA_SIDEBAR_INPUTS_IS_MAIN
  ) {
    next.lastActivityAt = Date.now()
  }
  if (updates.linkedWorkItem !== undefined) {
    next.linkedTask = updates.linkedWorkItem
  }
  return next
}
