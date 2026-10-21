import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { browserTabVisibilityPageIds } from './browser-guest-worktree-retention'
import { hasActiveBrowserPageDownload } from '../navigate/browser-page-download-activity'
import { browserPageNeedsPaintRetention } from './browser-guest-paint-retention'

// Why eviction needs more than the paint terms: eviction DESTROYS the guest rather than parking
// it, and main cancels a page's active downloads when its guest unregisters (tab-close semantics).
export function browserTabsVetoGuestEviction(tabs: readonly BrowserWorkspace[]): boolean {
  return tabs.some((tab) =>
    browserTabVisibilityPageIds(tab).some(
      (pageId) => browserPageNeedsPaintRetention(pageId) || hasActiveBrowserPageDownload(pageId)
    )
  )
}
