import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'

/**
 * Clear the parent link on each worktree and report a single failure toast.
 *
 * Shared by the context menu's "Remove parent link" and the drag-to-reorder un-nest. Both
 * fire-and-forget, and `updateWorktreeLineage` rejects when the owner route can't be resolved,
 * so neither may call it bare — the rejection would surface as an unhandled promise rejection
 * and the action would look like it succeeded.
 */
export async function unnestWorktrees(
  worktreeIds: readonly string[],
  updateWorktreeLineage: AppState['updateWorktreeLineage']
): Promise<void> {
  if (worktreeIds.length === 0) {
    return
  }
  try {
    await Promise.all(worktreeIds.map((id) => updateWorktreeLineage(id, { noParent: true })))
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
