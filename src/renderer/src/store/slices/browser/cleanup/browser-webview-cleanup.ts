import type {
  BrowserPage,
  BrowserWorkspace
} from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { closePersistentBrowserPage } from '../../../../components/browser-pane/host-guest/browser-webview-disposal'
import { releaseBrowserPageMount } from '../../../../components/browser-pane/host-guest/retention/browser-page-mount-admission'

// Release admission with guest destruction on close, purge, conversion or eviction.
export function destroyRemovedBrowserWebview(browserPageId: string): void {
  releaseBrowserPageMount(browserPageId)
  void closePersistentBrowserPage(browserPageId)
}

/** Destroys every page in `previousIds` the store no longer holds; returns the ids it holds now. */
export function destroyWebviewsRemovedFromStore(
  previousIds: ReadonlySet<string>,
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>
): Set<string> {
  const currentIds = collectBrowserWebviewIds(browserTabsByWorktree, browserPagesByWorkspace)
  for (const previousId of previousIds) {
    if (!currentIds.has(previousId)) {
      destroyRemovedBrowserWebview(previousId)
    }
  }
  return currentIds
}

export function collectBrowserWebviewIds(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>
): Set<string> {
  const ids = new Set<string>()
  for (const pages of Object.values(browserPagesByWorkspace)) {
    for (const page of pages) {
      ids.add(page.id)
    }
  }

  for (const tabs of Object.values(browserTabsByWorktree)) {
    for (const tab of tabs) {
      if ((browserPagesByWorkspace[tab.id] ?? []).length === 0) {
        ids.add(tab.id)
      }
    }
  }
  return ids
}

/** Sleep: every guest of one workspace's browser tabs (the tabs themselves stay). */
export function destroyWorktreeBrowserGuests(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  worktreeId: string
): void {
  for (const tab of browserTabsByWorktree[worktreeId] ?? []) {
    destroyWorkspaceWebviews(browserPagesByWorkspace, tab.id)
  }
}

export function destroyWorkspaceWebviews(
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  workspaceId: string
): void {
  const pages = browserPagesByWorkspace[workspaceId] ?? []
  if (pages.length === 0) {
    // Preserve workspace-ID destruction for legacy pre-page sessions.
    destroyRemovedBrowserWebview(workspaceId)
    return
  }
  for (const page of pages) {
    destroyRemovedBrowserWebview(page.id)
  }
}
