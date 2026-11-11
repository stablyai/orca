import { useAppStore } from '../../../store'
import { hasActiveBrowserPageDownload } from '../navigate/browser-page-download-activity'
import { browserPageNeedsPaintRetention } from './browser-guest-paint-retention'
import { browserGuestActivity } from './browser-guest-activity'
import { isBrowserPageRendererRecoveryPending } from './webview-registry'

export function browserPageVetoesGuestEviction(pageId: string): boolean {
  const protection = browserGuestActivity.get(pageId)?.protection
  const state = useAppStore.getState()
  return (
    state.settings?.browserGuestWorktreeRetentionBudget === false ||
    (protection !== undefined && protection !== 'discardable') ||
    isBrowserPageRendererRecoveryPending(pageId) ||
    browserPageNeedsPaintRetention(pageId) ||
    hasActiveBrowserPageDownload(pageId) ||
    Boolean(state.browserAudiblePageIds[pageId])
  )
}
