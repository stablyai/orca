import type { AppState } from '@/store/types'
import { selectDetectedWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { detectedWorktreeChangesAreIrrelevant } from '@/lib/workspace/ownership/detected-worktree-row-changes'
import { buildImportedWorktreesCardCandidates } from '@/components/sidebar/worktree-list/listing/imported-worktrees-card-candidates'

type Inputs = Pick<
  AppState,
  'repos' | 'detectedWorktreesByRepo' | 'worktreeVisibilityDefaultsByHost'
>
export const EMPTY_IMPORTED_PROJECT_REPO_IDS: ReadonlySet<string> = new Set()

/** The palette consumes candidate repo IDs, not unrelated activity on the complete raw catalog. */
export function createPaletteImportedProjectSelector() {
  let previous: Inputs | undefined
  let ids: ReadonlySet<string> = EMPTY_IMPORTED_PROJECT_REPO_IDS
  return (state: Inputs): ReadonlySet<string> => {
    const next = {
      repos: state.repos,
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
      worktreeVisibilityDefaultsByHost: state.worktreeVisibilityDefaultsByHost
    }
    const unchanged =
      previous &&
      previous.repos === next.repos &&
      previous.worktreeVisibilityDefaultsByHost === next.worktreeVisibilityDefaultsByHost &&
      detectedWorktreeChangesAreIrrelevant(
        selectDetectedWorktreesByRepo(previous),
        selectDetectedWorktreesByRepo(next),
        (before, after) =>
          !!before &&
          !!after &&
          before.visible === after.visible &&
          before.isBare === after.isBare &&
          before.selectedCheckout === after.selectedCheckout &&
          before.ownership === after.ownership,
        (before, after) => before.authoritative === after.authoritative
      )
    previous = next
    if (!unchanged) {
      const candidates = buildImportedWorktreesCardCandidates({
        repos: next.repos,
        detectedWorktreesByRepo: selectDetectedWorktreesByRepo(next),
        visibilityDefaultsByHost: next.worktreeVisibilityDefaultsByHost
      })
      if (candidates.size !== ids.size || [...candidates.keys()].some((id) => !ids.has(id))) {
        ids = new Set(candidates.keys())
      }
    }
    return ids
  }
}
