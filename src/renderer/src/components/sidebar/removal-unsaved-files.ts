import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store'
import type { WorktreePurgeTarget } from '@/store/slices/worktree-helpers'
import { collectRemovalUnsavedFiles } from '@/components/editor/removal-unsaved-editor-files'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getKnownRepoWorktreeIds } from '@/store/repos/repo-removal'

export function discardedUnsavedFilesLabel(count: number): string {
  return count === 1
    ? translate(
        'components.workspace.delete.unsavedEdits.discarded_one',
        'Unsaved edits in {{count}} file will be discarded:',
        { count }
      )
    : translate(
        'components.workspace.delete.unsavedEdits.discarded_other',
        'Unsaved edits in {{count}} files will be discarded:',
        { count }
      )
}

export function moreUnsavedFilesLabel(count: number): string {
  return translate('components.workspace.delete.unsavedEdits.moreFiles', 'and {{value}} more', {
    value: count
  })
}

/** The workspace ids project teardown purges (listed and detected rows), on the removed host. */
export function projectRemovalTargets(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  projects: readonly { repoId: string; hostId: ExecutionHostId | null }[]
): WorktreePurgeTarget[] {
  return projects.flatMap(({ repoId, hostId }) =>
    getKnownRepoWorktreeIds(state, repoId, hostId ?? undefined).map((id) => ({
      id,
      hostId: hostId ?? undefined
    }))
  )
}

/** Refuse removal without confirmation when it would discard unsaved editor text. */
export function blockRemovalForUnsavedFiles(
  getState: () => AppState,
  targets: readonly WorktreePurgeTarget[],
  name: string
): boolean {
  const count = collectRemovalUnsavedFiles(getState, targets).length
  if (count === 0) {
    return false
  }
  toast.error(
    count === 1
      ? translate(
          'components.workspace.delete.unsavedEdits.blocked_one',
          'Save or close {{count}} unsaved file in {{name}} first',
          { count, name }
        )
      : translate(
          'components.workspace.delete.unsavedEdits.blocked_other',
          'Save or close {{count}} unsaved files in {{name}} first',
          { count, name }
        )
  )
  return true
}
