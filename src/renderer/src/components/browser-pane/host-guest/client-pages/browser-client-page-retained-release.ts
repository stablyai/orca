import type { BrowserClientRetainedRendererPage as RetainedPage } from './browser-client-page-retained-state'

export function releaseBrowserClientRetainedRendererPage(page: RetainedPage): void {
  clearTimeout(page.attachTimer)
  page.releasePreparation()
  page.releaseDragPassthroughSurface()
  page.releasePaintRetention()
  page.visibleAttachment?.stopTrackingViewport()
  page.webview.removeEventListener('did-attach', page.onAttached)
  page.webview.removeEventListener('destroyed', page.onDestroyed)
  page.webview.removeEventListener('render-process-gone', page.onRendererGone)
  page.webview.removeEventListener('load-commit', page.onLoadCommit)
  page.visibleAttachment = null
  page.webview.remove()
  page.host.remove()
}
