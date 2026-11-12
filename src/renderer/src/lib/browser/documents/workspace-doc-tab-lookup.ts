import type { AppState } from '@/store/types'
import type { BrowserPageDocLocation } from '../../../../../shared/browser-workspace-types'
import { browserPageDocLocationsEqual } from '../../../../../shared/browser-page-doc-location'

/** The tab a document is already open in, found by every PAGE's docLocation and not just the
 *  workspace mirror — a mixed workspace whose doc page is inactive mirrors null. */
export function findWorkspaceShowingDoc(
  state: AppState,
  docLocation: BrowserPageDocLocation
): { workspaceId: string; pageId: string } | null {
  for (const tab of state.browserTabsByWorktree[docLocation.worktreeId] ?? []) {
    const page = (state.browserPagesByWorkspace[tab.id] ?? []).find((candidate) =>
      browserPageDocLocationsEqual(candidate.docLocation ?? null, docLocation)
    )
    if (page) {
      return { workspaceId: tab.id, pageId: page.id }
    }
  }
  return null
}
