import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeSlice } from '../../worktree-helpers'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import { reconcileFailedWorktreeMetaSave } from './worktree-meta-save-reconciliation'
import type { startWorktreeMetaSave } from './worktree-meta-save-reconciliation'

export async function worktreeMetaSaveFailureResult(
  get: WorktreeSliceGet,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  save: Awaited<ReturnType<typeof startWorktreeMetaSave>>,
  error: unknown
): Promise<Extract<Awaited<ReturnType<WorktreeSlice['updateWorktreeMeta']>>, { ok: false }>> {
  const unavailable = isRuntimeSelectorNotFoundError(error)
  if (!unavailable) {
    console.error('Failed to update worktree meta:', error)
  }
  try {
    await reconcileFailedWorktreeMetaSave(get, worktreeId, executionHostId, save)
  } catch (refreshError) {
    console.error('Failed to refresh worktrees after metadata update:', refreshError)
  }
  return unavailable
    ? {
        ok: false,
        error: translate(
          'auto.store.slices.worktrees.c6cf133786',
          'This workspace is no longer available.'
        )
      }
    : { ok: false, error: error instanceof Error ? error.message : String(error) }
}
