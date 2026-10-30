import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import {
  withoutForeignHostStatus,
  type StatusColumnOwner
} from '../../../host-workspace-status-columns'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

/** The card's host and runtime owner; null when neither the caller nor the store knows its host. */
function statusOwner(
  state: ReturnType<WorktreeSliceGet>,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): StatusColumnOwner | null {
  const card = findKnownWorktreeById(state, worktreeId, executionHostId)
  if (!card && !executionHostId) {
    return null
  }
  // A known card without a host id is local.
  return {
    hostId: executionHostId ?? card?.hostId ?? 'local',
    runtimeOwnerEnvironmentId: card?.runtimeOwnerEnvironmentId
  }
}

/** Every status write path keeps a card out of another paired host's columns. */
export function guardUpdateWorktreeMetaHostStatus(
  update: WorktreeSlice['updateWorktreeMeta'],
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeMeta'] {
  return (worktreeId, updates, options) => {
    const owner = statusOwner(get(), worktreeId, options?.executionHostId)
    if (!owner) {
      return update(worktreeId, updates, options)
    }
    const allowed = withoutForeignHostStatus(get(), owner, updates)
    // Why: a write that was only the dropped status has nothing left to persist.
    if (allowed !== updates && Object.keys(allowed).length === 0) {
      return Promise.resolve({ ok: true as const })
    }
    return update(worktreeId, allowed, options)
  }
}

export function guardUpdateWorktreesMetaHostStatus(
  update: WorktreeSlice['updateWorktreesMeta'],
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreesMeta'] {
  return (entries) => {
    const state = get()
    return update(
      entries.flatMap((entry) => {
        const owner = statusOwner(state, entry.worktreeId, entry.executionHostId)
        if (!owner) {
          return [entry]
        }
        const allowed = withoutForeignHostStatus(state, owner, entry.updates)
        return allowed !== entry.updates && Object.keys(allowed).length === 0
          ? []
          : [{ ...entry, updates: allowed }]
      })
    )
  }
}
