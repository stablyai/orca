import type {
  WorktreeDeleteState,
  WorktreeDeleteStateTarget,
  WorktreeSlice
} from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'

type DeleteStateKeyState = Parameters<typeof findKnownWorktreeById>[0]

/** The one key every delete-state write uses: the identity the sidebar card for that row reads. */
export function getWorktreeDeleteStateKey(
  state: DeleteStateKeyState,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): string {
  if (!executionHostId) {
    return worktreeId
  }
  // Why: a card whose record carries no host reads the bare id, even when the caller names its host.
  const record = findKnownWorktreeById(state, worktreeId, executionHostId)
  return record && !record.hostId
    ? worktreeId
    : composeWorktreeHostIdentity(executionHostId, worktreeId)
}

function getDeleteStateTargetKey(
  state: DeleteStateKeyState,
  target: string | WorktreeDeleteStateTarget
): string {
  return typeof target === 'string'
    ? target
    : getWorktreeDeleteStateKey(state, target.id, target.hostId)
}

function getDeleteStateTargetHostId(
  target: string | WorktreeDeleteStateTarget
): ExecutionHostId | undefined {
  return typeof target === 'string' ? undefined : target.hostId
}

export function removeDeleteStatesForWorktreeIds(
  states: Readonly<Record<string, WorktreeDeleteState>>,
  worktreeIds: ReadonlySet<string>
): Record<string, WorktreeDeleteState> {
  const next = { ...states }
  for (const [key, state] of Object.entries(states)) {
    for (const worktreeId of worktreeIds) {
      if (
        key === worktreeId ||
        (state.executionHostId != null &&
          key === composeWorktreeHostIdentity(state.executionHostId, worktreeId))
      ) {
        delete next[key]
        break
      }
    }
  }
  return next
}
export function createMarkWorktreesDeleting(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['markWorktreesDeleting'] {
  return (worktrees) => {
    if (worktrees.length === 0) {
      return
    }
    set((s) => {
      const nextDeleteState = { ...s.deleteStateByWorktreeId }
      let changed = false
      for (const [key, target] of new Map(
        worktrees.map((item) => [getDeleteStateTargetKey(s, item), item])
      )) {
        const executionHostId = getDeleteStateTargetHostId(target)
        const current = nextDeleteState[key]
        // Phase-aware: a queued row must still be promoted to deleting.
        if (
          current?.isDeleting &&
          current.phase === 'deleting' &&
          current.error === null &&
          !current.canForceDelete
        ) {
          continue
        }
        nextDeleteState[key] = {
          isDeleting: true,
          phase: 'deleting',
          ...(executionHostId ? { executionHostId } : {}),
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
        changed = true
      }
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : s
    })
  }
}

export function createMarkWorktreesQueuedForDeletion(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['markWorktreesQueuedForDeletion'] {
  return (worktrees) => {
    if (worktrees.length === 0) {
      return
    }
    set((s) => {
      const nextDeleteState = { ...s.deleteStateByWorktreeId }
      let changed = false
      for (const [key, target] of new Map(
        worktrees.map((item) => [getDeleteStateTargetKey(s, item), item])
      )) {
        const executionHostId = getDeleteStateTargetHostId(target)
        const current = nextDeleteState[key]
        if (current?.isDeleting && current.error === null && !current.canForceDelete) {
          continue
        }
        nextDeleteState[key] = {
          isDeleting: true,
          phase: 'queued',
          ...(executionHostId ? { executionHostId } : {}),
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
        changed = true
      }
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : s
    })
  }
}

export function createClearWorktreeDeleteState(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['clearWorktreeDeleteState'] {
  return (worktreeId, executionHostId) => {
    set((s) => {
      const key = getWorktreeDeleteStateKey(s, worktreeId, executionHostId)
      if (!s.deleteStateByWorktreeId[key]) {
        return s
      }
      const next = { ...s.deleteStateByWorktreeId }
      delete next[key]
      return { deleteStateByWorktreeId: next }
    })
  }
}
