import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  parseWorktreeHostIdentity
} from '../../../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { applyWorktreeUpdates } from '../worktrees/metadata/worktree-meta-update-application'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById
} from '../worktrees/listing/detected-worktree-meta'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import '../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../../shared/folder-workspaces/folder-workspace-host-id'
import { persistPassiveWorktreeMetaForOwner } from '../worktrees/listing/worktree-owner-settings'
import type { WorkspaceAttentionGet, WorkspaceAttentionSet } from './workspace-attention-contract'
import { workspaceHasLiveMarkerForHost } from './workspace-marker-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../shared/sidebar-inputs-switch'
import { ownerHostOwnsSidebarInputs } from '../worktrees/listing/owner-host-sidebar-inputs'
import { folderRowOnHost, folderRowToMark, isWorkspaceFlagSet } from './workspace-unread-flag-reads'

// The persisted workspace flag `isUnread`. Only the workspace-attention module writes it.

export function markWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string
): void {
  noteMarkerRaise(set, get, worktreeId)
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

/**
 * Record that a marker raises this workspace's flag, unless the flag is already up for another
 * reason (Mark as unread, a peer, a previous session): settling must not lower what it did not raise.
 * Checked before the raise, while the row still says whether the flag was down.
 */
function noteMarkerRaise(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string
): void {
  const state = get()
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const folderRow =
    workspaceScope?.type === 'folder'
      ? folderRowToMark(state, worktreeId, workspaceScope.folderWorkspaceId)
      : undefined
  const row = folderRow ?? findKnownWorktreeById(state, worktreeId)
  const hostId = folderRow
    ? getFolderWorkspaceHostId(folderRow, state.projectGroups)
    : getResolvedExecutionHostIdForWorktree(state, worktreeId)
  if (!row || row.isUnread || !hostId) {
    return
  }
  const identity = composeWorktreeHostIdentity(hostId, worktreeId)
  if (state.workspaceUnreadRaisedByMarkers[identity]) {
    return
  }
  set((s) => ({
    workspaceUnreadRaisedByMarkers: { ...s.workspaceUnreadRaisedByMarkers, [identity]: true }
  }))
}

function markerRaiseIdentities(
  state: ReturnType<WorkspaceAttentionGet>,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
) {
  return Object.keys(state.workspaceUnreadRaisedByMarkers).flatMap((key) => {
    const identity = parseWorktreeHostIdentity(key)
    return identity &&
      getWorktreeIdFromHostIdentity(identity) === worktreeId &&
      (!executionHostId || getExecutionHostIdFromWorktreeHostIdentity(identity) === executionHostId)
      ? [identity]
      : []
  })
}

/** Drop provenance for cleared host rows, or the row whose flag the user takes over. */
export function forgetMarkerRaise(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string,
  options?: { evenIfFlagged?: boolean; executionHostId?: ExecutionHostId | null }
): void {
  const state = get()
  const cleared = markerRaiseIdentities(state, worktreeId, options?.executionHostId).filter(
    (identity) =>
      options?.evenIfFlagged ||
      !isWorkspaceFlagSet(state, worktreeId, getExecutionHostIdFromWorktreeHostIdentity(identity))
  )
  if (cleared.length === 0) {
    return
  }
  set((s) => {
    const next = { ...s.workspaceUnreadRaisedByMarkers }
    for (const identity of cleared) {
      delete next[identity]
    }
    return { workspaceUnreadRaisedByMarkers: next }
  })
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
  lowerWorkspaceUnreadFlag(set, get, worktreeId, executionHostId)
  forgetMarkerRaise(set, get, worktreeId, { executionHostId })
}

function lowerWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string,
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
  const host = executionHostId ?? undefined
  const updates = { isUnread: false }
  let shouldPersist = false
  set((s) => {
    const worktree = findKnownWorktreeById(s, worktreeId, host)
    if (!worktree || !worktree.isUnread) {
      // Why: return `s` (not {}) to keep the object reference on a no-op, avoiding selector churn.
      return s
    }
    shouldPersist = true
    const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, updates, host)
    const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
      s.detectedWorktreesByRepo,
      worktreeId,
      updates,
      host
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
    updates,
    'persist cleared unread worktree state',
    host
  )
}

/**
 * Why the flag is being settled. `arrival`: the workspace came on screen, which reads any flag with
 * no live marker left (Mark as unread, a peer's, a restart's). `markers`: markers went away
 * elsewhere (acknowledged, closed, read on screen), which lowers only a flag those markers raised.
 */
export type WorkspaceUnreadSettleCause = 'arrival' | 'markers'

/** Lower each host flag only after its last live marker disappears. */
export function settleWorkspaceUnreadFlag(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  worktreeId: string,
  cause: WorkspaceUnreadSettleCause,
  executionHostId?: ExecutionHostId | null
): void {
  // Why only downward: raising here would override another client's Mark as read with this
  // renderer's local markers; marking already raises the flag together with its marker.
  const state = get()
  if (cause === 'markers') {
    for (const identity of markerRaiseIdentities(state, worktreeId, executionHostId)) {
      const hostId = getExecutionHostIdFromWorktreeHostIdentity(identity)
      if (!workspaceHasLiveMarkerForHost(state, worktreeId, hostId)) {
        clearWorkspaceUnreadFlag(set, get, worktreeId, hostId)
      }
    }
    return
  }
  if (!workspaceHasLiveMarkerForHost(state, worktreeId, executionHostId)) {
    clearWorkspaceUnreadFlag(set, get, worktreeId, executionHostId)
  }
}
