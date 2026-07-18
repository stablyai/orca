// Why: pinned panels share one persistent session so dashboard logins survive
// relaunch, but stay out of `persist:browser` — panel guests are chromeless and
// must not inherit or pollute the interactive browser's cookies.
export const PINNED_WEB_PANEL_PARTITION = 'persist:pinned-web-panels'

const webviewsByPanelId = new Map<string, Electron.WebviewTag>()

/** Creates (or returns) the panel's webview. The guest is created once per
 *  panel visit and then only re-shown — reparenting would destroy the guest
 *  document, losing dashboard state. */
export function ensurePinnedWebPanelWebview({
  panelId,
  url,
  container
}: {
  panelId: string
  url: string
  container: HTMLDivElement
}): Electron.WebviewTag {
  const existing = webviewsByPanelId.get(panelId)
  if (existing && existing.parentElement === container) {
    // Why: a URL edit in Settings must land without deleting and re-adding
    // the panel; loading in place preserves the guest and its session.
    if (existing.getAttribute('data-panel-url') !== url) {
      existing.setAttribute('data-panel-url', url)
      existing.setAttribute('src', url)
    }
    return existing
  }
  if (existing) {
    destroyPinnedWebPanelWebview(panelId)
  }
  const webview = document.createElement('webview') as Electron.WebviewTag
  webview.setAttribute('partition', PINNED_WEB_PANEL_PARTITION)
  webview.setAttribute('data-panel-url', url)
  webview.setAttribute('src', url)
  webview.style.display = 'flex'
  webview.style.flex = '1'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  // Why: some pages never paint a background, and a white viewport matches
  // normal browser behavior instead of leaking Orca chrome through the guest.
  webview.style.background = '#ffffff'
  webviewsByPanelId.set(panelId, webview)
  container.appendChild(webview)
  return webview
}

export function reloadPinnedWebPanelWebview(panelId: string): void {
  const webview = webviewsByPanelId.get(panelId)
  if (webview) {
    webview.reload()
  }
}

export function destroyPinnedWebPanelWebview(panelId: string): void {
  const webview = webviewsByPanelId.get(panelId)
  if (webview) {
    webview.remove()
    webviewsByPanelId.delete(panelId)
  }
}
