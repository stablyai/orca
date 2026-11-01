import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { useRepoById, useWorktreeById } from '@/store/selectors'
import type { OpenFile } from '@/store/slices/editor'
import { usePerforceEditedTab } from '../right-sidebar/perforce/use-perforce-edited-tab'

/**
 * A file tab's worktree and repo, plus its label: the display name with an "E " prefix while
 * Perforce has the file opened for edit.
 */
// Why one hook: EditorFileTab sits at the .tsx max-lines limit, so the Perforce label rides on
// the worktree/repo lookups the tab already needs.
export function useEditorTabTarget(file: OpenFile) {
  const worktree = useWorktreeById(file.worktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  const isOpenedForEdit = usePerforceEditedTab(file, worktree?.path ?? null, repo)
  const tabLabel = `${isOpenedForEdit ? 'E ' : ''}${getEditorDisplayLabel(file)}`
  return { worktree, repo, tabLabel }
}
