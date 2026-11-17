import type { GitGraphHistoryController } from './git-graph-history-controller'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'

// Keyed by result so it outlives tab remounts without keeping replaced history alive.
const pagedInView = new WeakSet<GitHistoryResult>()

/** Asks for the next page once per result; a failed or no-progress page keeps its result, so only Load more or Refresh retries it. */
export function loadMoreInView(
  controller: GitGraphHistoryController,
  rendered: GitHistoryResult | undefined
): void {
  const { result, loading } = controller.view.getState()
  // Only page the result whose rows were measured in view; a newer one gets its own check.
  if (result && result === rendered && result.hasMore && !loading && !pagedInView.has(result)) {
    pagedInView.add(result)
    void controller.loadMore()
  }
}
