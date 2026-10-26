import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'

/** Both callers fire-and-forget; catch owner-routing failures and toast once so unnest cannot silently fail or reject unhandled. */
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
