import type { BrowserGuestIdleDiscardToken } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'
import { browserGuestActivity, reportBrowserGuestVisibility } from './browser-guest-activity'

/** Main owns deadlines; the DOM owner makes the last synchronous visibility and local veto check. */
export function installBrowserGuestPageRetention(args: {
  isBlocked: (pageId: string) => boolean
  discard: (
    pageId: string,
    webview: Electron.WebviewTag,
    webContentsId: number,
    policyToken: BrowserGuestIdleDiscardToken
  ) => boolean
}): () => void {
  const remove = window.api?.browser.onGuestIdleDiscardDue?.((request) => {
    let discarded = false
    try {
      const entry = browserGuestActivity.get(request.browserPageId)
      if (
        entry &&
        entry.visible === false &&
        entry.visibilityGeneration === request.generation &&
        entry.webview.getWebContentsId() === request.webContentsId &&
        !args.isBlocked(request.browserPageId)
      ) {
        discarded = args.discard(
          request.browserPageId,
          entry.webview,
          request.webContentsId,
          request.policyToken
        )
      }
    } catch {
      // An unreadable or detached guest consumes this episode's attempt.
    } finally {
      if (!discarded) {
        window.api.browser.refuseGuestIdleDiscard?.(request)
      }
    }
  })
  for (const pageId of browserGuestActivity.keys()) {
    reportBrowserGuestVisibility(pageId)
  }
  return remove ?? (() => {})
}
