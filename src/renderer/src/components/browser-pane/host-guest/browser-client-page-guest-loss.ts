import type { MutableRefObject } from 'react'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

export type BrowserClientPageGuestLossReason = 'unreadable' | 'destroyed' | 'render-process-gone'

/**
 * Tells a client-hosted pane, once, that its guest is gone. The retained registry fences the tag on
 * `destroyed` / `render-process-gone` without telling the pane, which would otherwise sit mute or
 * spinning over a tag whose every method throws; a failed guest read is the same verdict.
 */
export function watchBrowserClientPageGuestLoss(options: {
  webview: Electron.WebviewTag
  /** Released on loss and dispose: every chrome action null-checks it, so a dead tag is never driven. */
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  browserPageId: string
  pageHostGeneration: number
  onLost: () => void
}): { lose(reason: BrowserClientPageGuestLossReason): void; dispose(): void } {
  const { webview } = options
  const releaseWebviewRef = (): void => {
    if (options.webviewRef.current === webview) {
      options.webviewRef.current = null
    }
  }
  let lost = false
  const lose = (reason: BrowserClientPageGuestLossReason): void => {
    if (lost) {
      return
    }
    lost = true
    // Why the breadcrumb: the crash report this replaces was the only field signal for guest death.
    recordRendererCrashBreadcrumb('browser_client_page_guest_unavailable', {
      browserPageId: options.browserPageId,
      pageHostGeneration: options.pageHostGeneration,
      reason,
      tagConnected: webview.isConnected
    })
    releaseWebviewRef()
    options.onLost()
  }
  const onDestroyed = (): void => lose('destroyed')
  const onRendererGone = (): void => lose('render-process-gone')
  webview.addEventListener('destroyed', onDestroyed)
  webview.addEventListener('render-process-gone', onRendererGone)
  return {
    lose,
    dispose: () => {
      lost = true
      releaseWebviewRef()
      webview.removeEventListener('destroyed', onDestroyed)
      webview.removeEventListener('render-process-gone', onRendererGone)
    }
  }
}
