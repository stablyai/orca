import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import type { OpenFile } from '@/store/slices/editor'
import type { Repo } from '../../../../shared/repo-types'
import { usePerforceEditedTab } from '../right-sidebar/perforce/use-perforce-edited-tab'

/** A file tab's label, with an "E " prefix while Perforce has the file opened for edit. */
export function useEditorTabLabel(
  file: OpenFile,
  worktreePath: string | null,
  repo: Repo | null | undefined
): string {
  const isOpenedForEdit = usePerforceEditedTab(file, worktreePath, repo)
  return `${isOpenedForEdit ? 'E ' : ''}${getEditorDisplayLabel(file)}`
}
