import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import { showWorktreeCreateWarningToast } from './worktree-create-warning-toast'

export async function pinCreatedWorktree(
  worktree: Worktree,
  hostId: ExecutionHostId,
  get: WorktreeSliceGet
): Promise<boolean> {
  if (worktree.isPinned) {
    return true
  }
  const result = await get().updateWorktreeMeta(
    worktree.id,
    { isPinned: true },
    {
      executionHostId: hostId
    }
  )
  if (!result.ok) {
    showWorktreeCreateWarningToast(
      translate(
        'auto.store.slices.worktrees.pinNewWorkspaceFailed',
        'The workspace was created, but could not be pinned.'
      )
    )
  }
  return result.ok
}
