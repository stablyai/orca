import { readIpcErrorDetail } from '@/lib/ipc-error'
import { isArchiveHookRemovalError } from '../../../../../../shared/worktree/archive-hook-removal-gate'
import {
  classifyWorktreeForceDeleteReason,
  getLockedWorktreeRemovalReason,
  isLockedWorktreeRemovalError
} from '../../../../../../shared/worktree/removal'
import type { WorktreeDeleteState, WorktreeDeleteStateTarget } from './worktree-delete-state-types'
import type { WorktreeSlice } from '../worktree-slice-contract'
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

export function markWorktreeRemovalStarted(
  set: WorktreeSliceSet,
  deleteStateKey: string,
  requiredExecutionHostId?: ExecutionHostId | null
): void {
  set((s) => ({
    deleteStateByWorktreeId: {
      ...s.deleteStateByWorktreeId,
      [deleteStateKey]: {
        isDeleting: true,
        phase: 'deleting',
        ...(requiredExecutionHostId ? { executionHostId: requiredExecutionHostId } : {}),
        error: null,
        canForceDelete: false,
        forceDeleteReason: null
      }
    }
  }))
}

export function failWorktreeRemoval(
  set: WorktreeSliceSet,
  deleteStateKey: string,
  requiredExecutionHostId: ExecutionHostId | null | undefined,
  err: unknown,
  force: boolean | undefined,
  allowUnverifiedPtyStop: boolean
) {
  // Why: git refusing a non-force delete for dirty/untracked files is a handled user decision, not an app error.
  console.warn('Failed to remove worktree:', err)
  // Strip IPC/channel wrappers so the user-facing refusal leads the toast.
  const error = readIpcErrorDetail(err) ?? (err instanceof Error ? err.message : String(err))
  const forceDeleteReason = classifyWorktreeForceDeleteReason(error, force, allowUnverifiedPtyStop)
  const locked = isLockedWorktreeRemovalError(error)
  // Only archive-hook refusal can be retried via waiver rather than state repair; expose that toast choice (#19334).
  const canWaiveArchiveHook = isArchiveHookRemovalError(error)
  set((s) => ({
    deleteStateByWorktreeId: {
      ...s.deleteStateByWorktreeId,
      [deleteStateKey]: {
        isDeleting: false,
        ...(requiredExecutionHostId ? { executionHostId: requiredExecutionHostId } : {}),
        error,
        canForceDelete: forceDeleteReason !== null,
        forceDeleteReason,
        ...(canWaiveArchiveHook ? { canWaiveArchiveHook: true } : {}),
        ...(locked ? { lockReason: getLockedWorktreeRemovalReason(error) } : {})
      }
    }
  }))
  return { ok: false as const, error }
}
