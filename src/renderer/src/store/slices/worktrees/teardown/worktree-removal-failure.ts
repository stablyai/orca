import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { resolveWorktreeRemovalPreference } from './worktree-removal-preference'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import { isArchiveHookRemovalError } from '../../../../../../shared/worktree/archive-hook-removal-gate'
import {
  classifyWorktreeForceDeleteReason,
  getLockedWorktreeRemovalReason,
  isLockedWorktreeRemovalError
} from '../../../../../../shared/worktree/removal'

export function recordWorktreeRemovalFailure(
  set: WorktreeSliceSet,
  deleteStateKey: string,
  requiredExecutionHostId: ExecutionHostId | null,
  policy: ReturnType<typeof resolveWorktreeRemovalPreference>,
  err: unknown
): { ok: false; error: string } {
  // Why: git refusing a non-force delete for dirty/untracked files is a handled user decision, not an app error.
  console.warn('Failed to remove worktree:', err)
  // Strip IPC/channel wrappers so the user-facing refusal leads the toast.
  const error = readIpcErrorDetail(err) ?? (err instanceof Error ? err.message : String(err))
  const forceDeleteReason = classifyWorktreeForceDeleteReason(
    error,
    policy.force,
    policy.options?.allowUnverifiedPtyStop === true
  )
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
