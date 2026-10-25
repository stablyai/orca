import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { browserTabVisibilityPageIds } from './browser-guest-worktree-retention'
import { hasActiveBrowserPageDownload } from '../navigate/browser-page-download-activity'
import { browserPageNeedsPaintRetention } from './browser-guest-paint-retention'

// Eviction destroys rather than parks guests; unregistering cancels active downloads, so they veto eviction too.
export function browserTabsVetoGuestEviction(tabs: readonly BrowserWorkspace[]): boolean {
  return tabs.some((tab) =>
    browserTabVisibilityPageIds(tab).some(
      (pageId) => browserPageNeedsPaintRetention(pageId) || hasActiveBrowserPageDownload(pageId)
    )
  )
}
