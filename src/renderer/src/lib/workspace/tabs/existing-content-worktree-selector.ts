import type { AppState } from '@/store/types'
import { structuralValuesEqualIgnoringUndefined } from '../../../../../shared/structural-value-equality'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { detectedWorktreeChangesAreIrrelevant } from '../ownership/detected-worktree-row-changes'
import {
  createExistingWorkspaceContentSelector,
  getExistingContentWorktrees
} from './existing-workspace-content'

/** Open-tab search uses row identity/name/path/owner; unread/activity belong to live status owners. */
function sameSearchMetadata(before: Worktree, after: Worktree): boolean {
  return (
    before === after ||
    structuralValuesEqualIgnoringUndefined(
      { ...before, isUnread: false, lastActivityAt: 0 },
      { ...after, isUnread: false, lastActivityAt: 0 }
    )
  )
}

/** Mount-local search input; no content catalog or membership authority is kept outside the mount. */
export function createExistingContentWorktreeSelector() {
  const selectIds = createExistingWorkspaceContentSelector()
  let previous:
    | Pick<
        AppState,
        | 'worktreesByRepo'
        | 'detectedWorktreesByRepo'
        | 'folderWorkspaces'
        | 'repos'
        | 'projectGroups'
      >
    | undefined
  let previousIds: readonly string[] | undefined
  let contentIds: ReadonlySet<string> = new Set()
  let rows: Worktree[] = []
  return (state: AppState): Worktree[] => {
    const ids = selectIds(state)
    const next = {
      worktreesByRepo: selectWorktreesByRepo(state),
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
      folderWorkspaces: selectFolderWorkspaces(state),
      repos: state.repos,
      projectGroups: state.projectGroups
    }
    const unchanged =
      previous &&
      ids === previousIds &&
      selectWorktreesByRepo(previous) === selectWorktreesByRepo(next) &&
      selectFolderWorkspaces(previous) === selectFolderWorkspaces(next) &&
      previous.repos === next.repos &&
      previous.projectGroups === next.projectGroups &&
      detectedWorktreeChangesAreIrrelevant(
        selectDetectedWorktreesByRepo(previous),
        selectDetectedWorktreesByRepo(next),
        (before, after) =>
          !!before &&
          !!after &&
          ((!contentIds.has(before.id) && !contentIds.has(after.id)) ||
            sameSearchMetadata(before, after))
      )
    if (ids !== previousIds) {
      contentIds = new Set(ids)
    }
    previous = next
    previousIds = ids
    if (!unchanged) {
      rows = getExistingContentWorktrees(next, ids)
    }
    return rows
  }
}
