import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import { getFolderWorkspaceMetaUpdates } from '../listing/detected-worktree-meta'
import { translate } from '@/i18n/i18n'

/**
 * The folder-workspace leg of updateWorktreeMeta. Folder rows are not git worktrees: their
 * metadata lives on the folder workspace, is filtered through a whitelist, and persists through
 * updateFolderWorkspace, so the git path's optimistic apply and persistence never run for them.
 */
export async function updateFolderWorkspaceMeta(
  get: WorktreeSliceGet,
  folderWorkspaceId: string,
  updates: Partial<WorktreeMeta>,
  executionHostId: ExecutionHostId | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  const folderUpdates = getFolderWorkspaceMetaUpdates(updates)
  if (Object.keys(folderUpdates).length === 0) {
    return { ok: true }
  }
  try {
    // Why: a rejected folder update reconciles the optimistic write away, so
    // reporting ok would show the dialog a save that silently undid itself.
    // Why: a folder id can exist on several hosts; without the host the write can land on the
    // active host instead of the selected one.
    const updated = await get().updateFolderWorkspace(
      folderWorkspaceId,
      folderUpdates,
      executionHostId ? { executionHostId } : undefined
    )
    return updated
      ? { ok: true }
      : {
          ok: false,
          error: translate(
            'auto.store.slices.worktrees.a17f4d2e93',
            'Could not update this workspace.'
          )
        }
  } catch (err) {
    console.error('Failed to update folder workspace meta:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
