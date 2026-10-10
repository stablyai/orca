import { readBrowserClientPageAttachedGuestId } from '../browser-client-page-retained-elements'

export function focusBrowserGuestForKeyboard(doc: Document, webContentsId: number): boolean {
  for (const webview of doc.querySelectorAll<Electron.WebviewTag>('webview')) {
    if (readBrowserClientPageAttachedGuestId(webview) === webContentsId) {
      webview.focus({ preventScroll: true })
      return doc.activeElement === webview
    }
  }
  return false
}
