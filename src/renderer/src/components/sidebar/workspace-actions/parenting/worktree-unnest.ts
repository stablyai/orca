import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../../shared/worktree/types'

/** Both callers fire-and-forget; catch owner-routing failures and toast once so unnest cannot silently fail or reject unhandled. */
export async function unnestWorktrees(
  /** A row's host routes it to its own machine; bare ids route as before. */
  worktrees: readonly (string | Pick<Worktree, 'id' | 'hostId'>)[],
  updateWorktreeLineage: AppState['updateWorktreeLineage']
): Promise<void> {
  if (worktrees.length === 0) {
    return
  }
  try {
    await Promise.all(
      worktrees.map((row) =>
        typeof row === 'string'
          ? updateWorktreeLineage(row, { noParent: true })
          : updateWorktreeLineage(row.id, {
              noParent: true,
              ...(row.hostId ? { executionHostId: row.hostId } : {})
            })
      )
    )
  } catch (err) {
    console.error('Failed to unnest workspace:', err)
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeList.failedUnnestWorkspace',
        'Failed to unnest workspace'
      )
    )
  }
}
