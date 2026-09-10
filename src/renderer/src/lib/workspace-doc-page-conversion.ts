/**
 * The address bar's route into a workspace document.
 *
 * Split out of `file-preview.ts` for its line budget, and it reads better here anyway: everything
 * in this file is about one page becoming a document page, while its neighbour is about deciding
 * how a file should open in the first place.
 */
import { toast } from 'sonner'
import { activateBrowserWorkspaceTab } from '@/lib/browser-workspace-tab-activation'
import { openFileInBrowserTab } from '@/lib/file-preview'
import { useAppStore } from '@/store'
import { findPage } from '@/store/slices/browser-page-records'
import type { BrowserPageConversionLeg } from '@/store/slices/browser-page-conversion'
import type { AppState } from '@/store/types'
import { browserPageDocLocationsEqual } from '../../../shared/browser-page-doc-location'
import type { BrowserPageDocLocation } from '../../../shared/browser-workspace-types'

/** The tab a document is already open in, found by every PAGE's docLocation and not just the
 *  workspace mirror — a mixed workspace whose doc page is inactive mirrors null. */
function findWorkspaceShowingDoc(
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

/**
 * The address bar's way into a workspace document: reuse before converting. A document already on
 * screen is a request to look at it — two tabs of one document would each hold their own grant on
 * the same file — so an existing tab wins and the current page stays what it was; only otherwise
 * does the page convert in place.
 */
export function convertBrowserPageToWorkspaceDoc(
  pageId: string,
  docLocation: BrowserPageDocLocation,
  options?: { leg?: BrowserPageConversionLeg }
): 'activated-existing' | 'opened-in-owning-worktree' | 'converted' | 'failed' {
  const state = useAppStore.getState()
  // Why a history leg skips reuse: Back and Forward both mean "this tab, as it was" — activating
  // another tab showing the document would leave this one a web page with live provenance, so
  // history could jump there forever. A history leg's document was this tab's own, so converting
  // in place is right.
  const isHistoryLeg = options?.leg !== undefined
  const existing = isHistoryLeg ? null : findWorkspaceShowingDoc(state, docLocation)
  if (existing) {
    // Why the worktree switches first: activation is deliberately scoped to the active worktree,
    // so without the switch a cross-worktree reuse would happen entirely out of sight.
    if (state.activeWorktreeId !== docLocation.worktreeId) {
      state.setActiveWorktree(docLocation.worktreeId)
    }
    if (
      !activateBrowserWorkspaceTab({
        worktreeId: docLocation.worktreeId,
        workspaceId: existing.workspaceId
      })
    ) {
      state.setActiveBrowserTab(existing.workspaceId)
    }
    state.setActiveBrowserPage(existing.workspaceId, existing.pageId)
    return 'activated-existing'
  }
  // Why another worktree's document opens a tab there instead of converting this one: a converted
  // page keeps its workspace row, and a row whose worktree differs from its document's can never
  // be the reader's surface under the per-worktree activity slots — its guest would never take
  // focus, and every link in the document would be a dead end.
  const owningPage = findPage(state.browserPagesByWorkspace, pageId)
  if (!isHistoryLeg && owningPage && owningPage.worktreeId !== docLocation.worktreeId) {
    // The reader follows the document to its worktree; opening it out of sight is indistinguishable
    // from nothing having happened.
    if (state.activeWorktreeId !== docLocation.worktreeId) {
      state.setActiveWorktree(docLocation.worktreeId)
    }
    const plan = openFileInBrowserTab({
      filePath: docLocation.filePath,
      worktreeId: docLocation.worktreeId
    })
    if (plan.status === 'unsupported') {
      toast.error(plan.message)
      return 'failed'
    }
    return 'opened-in-owning-worktree'
  }
  return state.convertBrowserPage(pageId, { kind: 'workspace-doc', docLocation }, options)
    ? 'converted'
    : 'failed'
}
