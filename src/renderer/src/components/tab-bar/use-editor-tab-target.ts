import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { getOpenFileExecutionHostId } from '@/lib/workspace/ownership/unified-tab-host-ownership'
import { resolveReviewRepository } from '@/lib/source-control/review/review-owner'
import { useAppStore } from '@/store'
import { useWorktreeById } from '@/store/workspaces/selection/use-selected-worktree'
import { editorTabWorkspace } from '@/store/slices/editor/tabs/workspace-editor-files'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { usePerforceEditedTab } from '../right-sidebar/perforce/use-perforce-edited-tab'

/**
 * A file tab's worktree and repo, plus its label: the display name with an "E " prefix while
 * Perforce has the file opened for edit, and the repo name when the tab sits in another workspace.
 */
// Why one hook: EditorFileTab sits at the .tsx max-lines limit, so the Perforce label rides on
// the worktree/repo lookups the tab already needs.
export function useEditorTabTarget(file: OpenFile & { tabId?: string }, t: Translate = translate) {
  const placedElsewhere = useAppStore((state) =>
    file.tabId
      ? editorTabWorkspace(state.unifiedTabsByWorktree, file.tabId) !== file.worktreeId
      : false
  )
  const worktree = useWorktreeById(file.worktreeId, getOpenFileExecutionHostId(file))
  const repo = useAppStore((state) =>
    worktree ? resolveReviewRepository(state.repos, worktree) : null
  )
  const isOpenedForEdit = usePerforceEditedTab(file, worktree?.path ?? null, repo)
  const repoSuffix = placedElsewhere && repo ? ` · ${repo.displayName}` : ''
  const tabLabel = `${isOpenedForEdit ? 'E ' : ''}${getEditorDisplayLabel(file, undefined, t)}${repoSuffix}`
  return { worktree, repo, tabLabel }
}
