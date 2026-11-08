import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { browserTabVisibilityPageIds } from './browser-guest-worktree-retention'
import { hasActiveBrowserPageDownload } from '../navigate/browser-page-download-activity'
import { browserPageNeedsPaintRetention } from './browser-guest-paint-retention'

// Agents, phones and paired viewers use pages without activating their worktree; this marks that use.
export function browserTabsNeedPaintRetention(tabs: readonly BrowserWorkspace[]): boolean {
  return tabs.some((tab) => browserTabVisibilityPageIds(tab).some(browserPageNeedsPaintRetention))
}

// Eviction destroys rather than parks guests; unregistering cancels active downloads, so they veto eviction too.
export function browserTabsVetoGuestEviction(tabs: readonly BrowserWorkspace[]): boolean {
  return (
    browserTabsNeedPaintRetention(tabs) ||
    tabs.some((tab) => browserTabVisibilityPageIds(tab).some(hasActiveBrowserPageDownload))
  )
}
