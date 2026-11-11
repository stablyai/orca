import type {
  BrowserPage,
  BrowserWorkspace
} from '../../../../../../shared/browser-workspace-types'
import { closePersistentBrowserPage } from '../../../../components/browser-pane/host-guest/webview-registry'
import { releaseBrowserPageMount } from '../../../../components/browser-pane/host-guest/browser-page-mount-admission'

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
