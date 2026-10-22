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
  // Switch point: the owning host raises the flag from the same news, unless it is older.
  // Why the row's host now: same-id folder rows differ by host, and the screen can move to the
  // other row while the owner is asked.
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

/** Raises still waiting on their owner check, per workspace, with the reads seen meanwhile. Why
 *  not per host: a read names its row's host differently from the row's own host lookup (a
 *  group-hosted folder reads as 'local'), so a per-host count could miss the read it must see. */
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

/**
 * The flag follows its markers — a read or removal clears it once no live marker remains.
 * Why every same-id folder row without a host: tabs are keyed by workspace id, not host, so a
 * marker can't be attributed to one host's row; a row is lowered only when the shared id has no
 * live marker at all, so purging host A's tabs lowers host B only if B holds none either.
 */
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
