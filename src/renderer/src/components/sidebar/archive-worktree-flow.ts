import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'
import { runSleepWorktrees } from './sleep-worktree-flow'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'

// Why: the primary checkout stands in for the project row, and folder-workspace
// lanes do not filter archived rows yet, so hiding either would misbehave.
export function isArchivableWorktree(worktree: Worktree): boolean {
  return (
    !worktree.isArchived &&
    !worktree.isMainWorktree &&
    parseWorkspaceKey(worktree.id)?.type !== 'folder'
  )
}

type ArchiveWriteResult = { succeededIds: string[]; failedIds: string[] }

async function setWorktreesArchived(
  worktreeIds: readonly string[],
  isArchived: boolean
): Promise<ArchiveWriteResult> {
  const { updateWorktreeMeta } = useAppStore.getState()
  const results = await Promise.all(
    worktreeIds.map(async (id) => ({
      id,
      result: await updateWorktreeMeta(id, { isArchived })
    }))
  )
  return {
    succeededIds: results.filter(({ result }) => result.ok).map(({ id }) => id),
    failedIds: results.filter(({ result }) => !result.ok).map(({ id }) => id)
  }
}

function reportArchiveFailures(failedIds: readonly string[]): void {
  if (failedIds.length === 0) {
    return
  }
  toast.error(
    failedIds.length === 1
      ? translate(
          'auto.components.sidebar.archive.worktree.flow.failed',
          'Failed to archive workspace'
        )
      : translate(
          'auto.components.sidebar.archive.worktree.flow.failedMany',
          'Failed to archive {{value0}} workspaces',
          { value0: failedIds.length }
        )
  )
}

async function undoArchiveWorktrees(worktreeIds: readonly string[]): Promise<void> {
  const { failedIds } = await setWorktreesArchived(worktreeIds, false)
  if (failedIds.length > 0) {
    toast.error(
      translate(
        'auto.components.sidebar.archive.worktree.flow.undoFailed',
        'Failed to undo archive'
      )
    )
  }
}

/**
 * Archive = sleep (release PTYs/browsers, keep tab records) + hide from the
 * sidebar. Unlike delete, the worktree and branch stay on disk.
 */
export async function runArchiveWorktrees(worktreeIds: readonly string[]): Promise<void> {
  if (worktreeIds.length === 0) {
    return
  }
  const { activeWorktreeId } = useAppStore.getState()
  const archivingActiveId =
    activeWorktreeId && worktreeIds.includes(activeWorktreeId) ? activeWorktreeId : null
  const commitFocus = archivingActiveId
    ? prepareActiveWorktreeFocusAfterDelete(archivingActiveId)
    : null
  await runSleepWorktrees(worktreeIds)
  // Why: failed sleeps and workspaces the user reopened mid-batch are both awake; keep them visible.
  const { succeededIds: archivedIds, failedIds } = await setWorktreesArchived(
    worktreeIds.filter((id) => hasWorktreeSleepIntent(id)),
    true
  )
  if (archivingActiveId && archivedIds.includes(archivingActiveId)) {
    commitFocus?.()
  } else if (archivingActiveId && useAppStore.getState().activeWorktreeId === null) {
    // Why: sleep cleared the selection, but the row is still visible since its archive write failed.
    useAppStore.getState().setActiveWorktree(archivingActiveId)
  }
  reportArchiveFailures(failedIds)
  if (archivedIds.length === 0) {
    return
  }
  toast.success(
    archivedIds.length === 1
      ? translate('auto.components.sidebar.archive.worktree.flow.archivedOne', 'Workspace archived')
      : translate(
          'auto.components.sidebar.archive.worktree.flow.archivedMany',
          '{{value0}} workspaces archived',
          { value0: archivedIds.length }
        ),
    {
      description: translate(
        'auto.components.sidebar.archive.worktree.flow.restoreHint',
        'Restore it from Workspace options → Archived.'
      ),
      action: {
        label: translate('auto.components.sidebar.archive.worktree.flow.undo', 'Undo'),
        onClick: () => {
          void undoArchiveWorktrees(archivedIds)
        }
      }
    }
  )
}

export async function runRestoreArchivedWorktree(worktreeId: string): Promise<void> {
  const {
    succeededIds: [restoredId]
  } = await setWorktreesArchived([worktreeId], false)
  if (!restoredId) {
    toast.error(
      translate(
        'auto.components.sidebar.archive.worktree.flow.restoreFailed',
        'Failed to restore workspace'
      )
    )
    return
  }
  activateAndRevealWorktree(restoredId, { navigationIntent: 'user-open' })
}
