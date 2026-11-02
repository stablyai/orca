import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import {
  buildWorkspaceReviewFacts,
  workspaceReviewFactsEqual,
  WorkspaceReviewFactsSnapshotSchema,
  type WorkspaceReviewFact
} from '../../../../shared/sidebar-list/workspace-review-facts'
import { defineSidebarShadowDomain } from './sidebar-shadow-comparison'
import { toLocallyOwnedRows } from './workspace-activity-shadow'

/**
 * Checks main's copy of the PR cache, and how it keys rows, against the window's own cache. An SSH
 * host that was down when main started has no rows in main yet, so its PR rows can read as mismatches.
 */
export const workspaceReviewShadow = defineSidebarShadowDomain<WorkspaceReviewFact>({
  name: 'workspace-review',
  readWindow: () => {
    const state = useAppStore.getState()
    const facts = buildWorkspaceReviewFacts(
      getAllWorktreesFromState(state),
      state.repos,
      state.prCache
    )
    return toLocallyOwnedRows(state, new Map(Object.entries(facts)))
  },
  readMain: async () => {
    const response = await window.api.runtime.call({ method: 'sidebarInputs.reviewFacts' })
    const parsed = response.ok
      ? WorkspaceReviewFactsSnapshotSchema.safeParse(response.result)
      : null
    if (!parsed?.success) {
      return null
    }
    return {
      values: toLocallyOwnedRows(useAppStore.getState(), new Map(Object.entries(parsed.data.facts)))
    }
  },
  equals: workspaceReviewFactsEqual
})
