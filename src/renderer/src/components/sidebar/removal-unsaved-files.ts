import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store'
import type { WorktreePurgeTarget } from '@/store/slices/worktree-helpers'
import { collectRemovalUnsavedFiles } from '@/components/editor/removal-unsaved-editor-files'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getKnownRepoWorktreeIds } from '@/store/repos/repo-removal'

export function discardedUnsavedFilesLabel(count: number): string {
  return translate(
    'components.workspace.delete.unsavedEdits.discarded',
    'Unsaved edits in {{count}} files will be discarded:',
    { count, defaultValue_one: 'Unsaved edits in {{count}} file will be discarded:' }
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
    translate(
      'components.workspace.delete.unsavedEdits.blocked',
      'Save or close {{count}} unsaved files in {{name}} first',
      { count, name, defaultValue_one: 'Save or close {{count}} unsaved file in {{name}} first' }
    )
  )
  return true
}
