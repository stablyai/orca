import {
  CANVAS_BROWSER_PARTITION,
  PINNED_WEB_PANEL_PARTITION
} from '../../../../shared/pinned-web-panels'

export { CANVAS_BROWSER_PARTITION }

const webviewsByPanelId = new Map<string, Electron.WebviewTag>()

export type PinnedWebPanelNavState = { canGoBack: boolean; canGoForward: boolean }

const NAV_STATE_IDLE: PinnedWebPanelNavState = { canGoBack: false, canGoForward: false }
const navStateByPanelId = new Map<string, PinnedWebPanelNavState>()
const navStateListeners = new Set<() => void>()

function updateNavState(panelId: string, webview: Electron.WebviewTag): void {
  const next = { canGoBack: webview.canGoBack(), canGoForward: webview.canGoForward() }
  const prev = navStateByPanelId.get(panelId)
  if (prev && prev.canGoBack === next.canGoBack && prev.canGoForward === next.canGoForward) {
    return
  }
  navStateByPanelId.set(panelId, next)
  for (const listener of navStateListeners) {
    listener()
  }
}

/** Snapshot for useSyncExternalStore — stable object identity between changes. */
export function getPinnedWebPanelNavState(panelId: string | null): PinnedWebPanelNavState {
  return (panelId !== null && navStateByPanelId.get(panelId)) || NAV_STATE_IDLE
}

export function subscribePinnedWebPanelNavState(listener: () => void): () => void {
  navStateListeners.add(listener)
  return () => {
    navStateListeners.delete(listener)
  }
}

export function navigatePinnedWebPanelWebview(
  panelId: string,
  direction: 'back' | 'forward'
): void {
  const webview = webviewsByPanelId.get(panelId)
  if (!webview) {
    return
  }
  if (direction === 'back' && webview.canGoBack()) {
    webview.goBack()
  } else if (direction === 'forward' && webview.canGoForward()) {
    webview.goForward()
  }
}

/** Creates (or returns) the panel's webview. The guest is created once per
 *  panel visit and then only re-shown — reparenting would destroy the guest
 *  document, losing dashboard state. */
export function ensurePinnedWebPanelWebview({
  panelId,
  url,
  container,
  partition = PINNED_WEB_PANEL_PARTITION
}: {
  panelId: string
  url: string
  container: HTMLDivElement
  /** Override guest partition (canvas blank browsers use CANVAS_BROWSER_PARTITION). */
  partition?: string
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
  webview.setAttribute('partition', partition)
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
  // Why: webGUIs without their own navigation can strand the user — track
  // history state so the panel header can offer real back/forward buttons.
  // did-navigate-in-page matters as much as did-navigate: SPAs (dashboards
  // especially) mutate history without full loads.
  for (const eventName of ['did-navigate', 'did-navigate-in-page', 'dom-ready'] as const) {
    webview.addEventListener(eventName, () => updateNavState(panelId, webview))
  }
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
    navStateByPanelId.delete(panelId)
    for (const listener of navStateListeners) {
      listener()
    }
  }
}
