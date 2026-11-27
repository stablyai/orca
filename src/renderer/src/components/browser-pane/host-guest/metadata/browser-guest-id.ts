export function readBrowserGuestId(webview: Electron.WebviewTag): number | null {
  try {
    return webview.getWebContentsId()
  } catch {
    return null
  }
}
