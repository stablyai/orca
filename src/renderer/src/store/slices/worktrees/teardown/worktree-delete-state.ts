import type {
  WorktreeDeleteState,
  WorktreeDeleteStateTarget,
  WorktreeSlice
} from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

function getDeleteStateTargetKey(target: string | WorktreeDeleteStateTarget): string {
  if (typeof target === 'string') {
    return target
  }
  return target.hostId ? getWorktreeHostIdentity(target) : target.id
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
      for (const target of new Map(
        worktrees.map((item) => [getDeleteStateTargetKey(item), item])
      ).values()) {
        const key = getDeleteStateTargetKey(target)
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
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : {}
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
      for (const target of new Map(
        worktrees.map((item) => [getDeleteStateTargetKey(item), item])
      ).values()) {
        const key = getDeleteStateTargetKey(target)
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
      return changed ? { deleteStateByWorktreeId: nextDeleteState } : {}
    })
  }
}

export function createClearWorktreeDeleteState(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['clearWorktreeDeleteState'] {
  return (worktreeId, executionHostId) => {
    const key = executionHostId
      ? composeWorktreeHostIdentity(executionHostId, worktreeId)
      : worktreeId
    set((s) => {
      if (!s.deleteStateByWorktreeId[key]) {
        return {}
      }
      const next = { ...s.deleteStateByWorktreeId }
      delete next[key]
      return { deleteStateByWorktreeId: next }
    })
  }
}
