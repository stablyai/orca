import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { applyWorktreeUpdates } from '../worktree-helpers'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById
} from '../worktrees/listing/detected-worktree-meta'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import { getFolderWorkspaceHostId } from '../../../../../shared/folder-workspace-execution-host'
import type { AppState } from '../../types'
import { persistPassiveWorktreeMetaForOwner } from '../worktrees/listing/worktree-owner-settings'
import type { WorkspaceAttentionGet, WorkspaceAttentionSet } from './workspace-attention-contract'
import { workspaceHasLiveMarker } from './workspace-live-markers'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../shared/sidebar-inputs-switch'
import { ownerHostOwnsSidebarInputs } from '../worktrees/listing/owner-host-sidebar-inputs'

// The persisted workspace flag `isUnread`. Only the workspace-attention module writes it.

export function markWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string
): void {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    raiseWorkspaceUnreadFlag(set, get, worktreeId)
    return
  }
  // Capture the row’s host before async owner check: same-ID folder focus may move meanwhile. Current owners raise flags; legacy owners need renderer fallback.
  const state = get()
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const folderRow =
    workspaceScope?.type === 'folder'
      ? folderRowToMark(state, worktreeId, workspaceScope.folderWorkspaceId)
      : undefined
  const folderHostId = folderRow
    ? getFolderWorkspaceHostId(folderRow, state.projectGroups)
    : undefined
  const pending = pendingRaises.get(worktreeId) ?? { raises: 0, reads: 0 }
  pendingRaises.set(worktreeId, pending)
  pending.raises += 1
  const readsBefore = pending.reads
  void ownerHostOwnsSidebarInputs(state, worktreeId, folderHostId)
    .then((ownerRaises) => {
      // A read while the owner was being asked already covers this news.
      if (!ownerRaises && pending.reads === readsBefore) {
        raiseWorkspaceUnreadFlag(set, get, worktreeId, folderHostId)
      }
    })
    .finally(() => {
      pending.raises -= 1
      if (pending.raises === 0) {
        pendingRaises.delete(worktreeId)
      }
    })
}

/** Track pending raises/reads by workspace: group-hosted folder reads can name local while owner lookup names another host, so per-host counters would miss reads. */
const pendingRaises = new Map<string, { raises: number; reads: number }>()

/** A read of the workspace by any path; a raise still waiting on its owner check drops. */
export function noteWorkspaceRead(worktreeId: string): void {
  const pending = pendingRaises.get(worktreeId)
  if (pending) {
    pending.reads += 1
  }
}

/** Same-id folder rows: the on-screen host's, else the first. */
function folderRowToMark(
  state: AppState,
  worktreeId: string,
  folderWorkspaceId: string
): FolderWorkspace | undefined {
  return folderRowOnHost(state, folderWorkspaceId, onScreenHostId(state, worktreeId))
}

/** The folder row on `host`, or the first same-id row when no host is named. */
function folderRowOnHost(
  state: AppState,
  folderWorkspaceId: string,
  host: ExecutionHostId | null
): FolderWorkspace | undefined {
  return state.folderWorkspaces.find(
    (workspace) =>
      workspace.id === folderWorkspaceId &&
      (!host || getFolderWorkspaceHostId(workspace, state.projectGroups) === host)
  )
}

function raiseWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string,
  /** The folder row's host when the news arrived; unset picks the on-screen row now. */
  folderHostId?: ExecutionHostId
): void {
  const stamp = { lastActivityAt: Date.now() }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspaceId = workspaceScope.folderWorkspaceId
    const state = get()
    const marked = folderHostId
      ? folderRowOnHost(state, folderWorkspaceId, folderHostId)
      : folderRowToMark(state, worktreeId, folderWorkspaceId)
    if (!marked || marked.isUnread) {
      return
    }
    set((s) => ({
      folderWorkspaces: s.folderWorkspaces.map((workspace) =>
        workspace === marked ? { ...workspace, isUnread: true, ...stamp } : workspace
      ),
      sortEpoch: s.sortEpoch + 1
    }))
    // Why the row's own host: the row flipped here is the owner updateFolderWorkspace writes.
    void get().updateFolderWorkspace(
      folderWorkspaceId,
      { isUnread: true, ...stamp },
      {
        executionHostId: getFolderWorkspaceHostId(marked, state.projectGroups)
      }
    )
    return
  }
  let shouldPersist = false
  set((s) => {
    const worktree = findKnownWorktreeById(s, worktreeId)
    if (!worktree || worktree.isUnread) {
      return s
    }
    shouldPersist = true
    const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
      isUnread: true,
      ...stamp
    })
    const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
      s.detectedWorktreesByRepo,
      worktreeId,
      {
        isUnread: true,
        ...stamp
      }
    )
    return {
      ...(nextWorktrees !== s.worktreesByRepo
        ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
        : {}),
      ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
        ? { detectedWorktreesByRepo: nextDetectedWorktrees }
        : {})
    }
  })

  if (!shouldPersist) {
    return
  }

  persistPassiveWorktreeMetaForOwner(
    get,
    worktreeId,
    { isUnread: true, ...stamp },
    'persist unread worktree state'
  )
}

export function clearWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string,
  /** Folder rows share an id across hosts: the on-screen host's row, or null for every row. */
  executionHostId?: ExecutionHostId | null
): void {
  noteWorkspaceRead(worktreeId)
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const folderWorkspaceId = workspaceScope.folderWorkspaceId
    const { folderWorkspaces, projectGroups } = get()
    const hostOf = (workspace: FolderWorkspace): ExecutionHostId =>
      getFolderWorkspaceHostId(workspace, projectGroups)
    const cleared = folderWorkspaces.filter(
      (workspace) =>
        workspace.id === folderWorkspaceId &&
        workspace.isUnread &&
        (!executionHostId || hostOf(workspace) === executionHostId)
    )
    if (cleared.length === 0) {
      return
    }
    // Why: flip locally first so repeated reads dedupe on the guard above before the IPC round-trip lands.
    set((s) => ({
      folderWorkspaces: s.folderWorkspaces.map((workspace) =>
        cleared.includes(workspace) ? { ...workspace, isUnread: false } : workspace
      )
    }))
    for (const workspace of cleared) {
      void get().updateFolderWorkspace(
        folderWorkspaceId,
        { isUnread: false },
        { executionHostId: hostOf(workspace) }
      )
    }
    return
  }
  let shouldPersist = false
  set((s) => {
    const worktree = findKnownWorktreeById(s, worktreeId)
    if (!worktree || !worktree.isUnread) {
      // Why: return `s` (not {}) to keep the object reference on a no-op, avoiding selector churn.
      return s
    }
    shouldPersist = true
    const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
      isUnread: false
    })
    const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
      s.detectedWorktreesByRepo,
      worktreeId,
      {
        isUnread: false
      }
    )
    return {
      ...(nextWorktrees !== s.worktreesByRepo ? { worktreesByRepo: nextWorktrees } : {}),
      ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
        ? { detectedWorktreesByRepo: nextDetectedWorktrees }
        : {})
    }
  })

  if (!shouldPersist) {
    return
  }

  persistPassiveWorktreeMetaForOwner(
    get,
    worktreeId,
    { isUnread: false },
    'persist cleared unread worktree state'
  )
}

/** Lower flags only after the last live marker disappears. Unscoped same-ID folders share workspace-keyed markers, so lower every row only when none remain. */
export function settleWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): void {
  // Why only downward: raising here would override another client's Mark as read with this
  // renderer's local markers; marking already raises the flag together with its marker.
  if (!workspaceHasLiveMarker(get(), worktreeId)) {
    clearWorkspaceUnreadFlag(set, get, worktreeId, executionHostId)
  }
}

/** The host whose row is on screen: the active workspace's, else null (every same-id row). */
export function onScreenHostId(
  state: Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>,
  worktreeId: string
): ExecutionHostId | null {
  return worktreeId === state.activeWorktreeId ? state.activeWorkspaceExecutionHostId : null
}

/** The flag {@link clearWorkspaceUnreadFlag} would clear. */
export function isWorkspaceFlagSet(
  state: Parameters<typeof findKnownWorktreeById>[0] & Pick<AppState, 'projectGroups'>,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): boolean {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return state.folderWorkspaces.some(
      (workspace) =>
        workspace.id === workspaceScope.folderWorkspaceId &&
        Boolean(workspace.isUnread) &&
        (!executionHostId ||
          getFolderWorkspaceHostId(workspace, state.projectGroups) === executionHostId)
    )
  }
  return Boolean(findKnownWorktreeById(state, worktreeId)?.isUnread)
}
