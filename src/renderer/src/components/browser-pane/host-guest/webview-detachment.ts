import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

export function detachBrowserWebview(webview: Electron.WebviewTag): void {
  const ownerWindow = webview.ownerDocument.defaultView
  let guestId: number | null = null
  try {
    guestId = webview.getWebContentsId()
  } catch {
    // An unattached tag has no native guest to retire.
  }
  const handleDetachError = (event: ErrorEvent): void => {
    // Electron's disconnect callback can race main-process guest destruction.
    if (
      guestId === null ||
      event.message !== `Uncaught Error: Invalid guestInstanceId: ${guestId}` ||
      !String(event.error?.stack).includes('WebViewElement.disconnectedCallback')
    ) {
      return
    }
    event.preventDefault()
    recordRendererCrashBreadcrumb('browser_guest_already_destroyed_on_detach', { guestId })
  }
  ownerWindow?.addEventListener('error', handleDetachError)
  try {
    webview.remove()
  } finally {
    ownerWindow?.removeEventListener('error', handleDetachError)
  }
}
