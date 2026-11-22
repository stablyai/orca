import type { BrowserExtensionSidePanel } from '../../../../../shared/browser/extensions/browser-extension-side-panel-types'
import { BROWSER_GUEST_WINDOW_CLOSE_CHANNEL } from '../../../../../shared/browser/guest-lifecycle/browser-guest-window-close'
import { ORCA_BROWSER_PAGE_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../../shared/browser/guest-lifecycle/browser-guest-web-preferences'
import { BROWSER_SIDE_PANEL_WIDTH_VARIABLE } from '../host-guest/viewport/browser-page-viewport'
import {
  isWebviewDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from '../host-guest/drag/webview-drag-passthrough'

/** A workspace's panel box: React draws the header into `chrome`, guests live in `guests`. */
export type BrowserExtensionSidePanelHost = {
  root: HTMLDivElement
  chrome: HTMLDivElement
  guests: HTMLDivElement
}

type PanelWebview = { webview: Electron.WebviewTag; host: HTMLDivElement; dispose: () => void }

// Why module state, not effects: Electron destroys a guest whose <webview> leaves the DOM, and
// main closes a panel whose guest is destroyed, so only a closed panel may lose its element.
const hosts = new Map<string, BrowserExtensionSidePanelHost>()
const webviews = new Map<string, PanelWebview>()

/** The workspace's panel box inside its slot root, rebuilt only when the slot root is replaced. */
export function ensureBrowserExtensionSidePanelHost(
  workspaceId: string,
  slotRoot: HTMLDivElement
): BrowserExtensionSidePanelHost {
  const existing = hosts.get(workspaceId)
  if (existing && existing.root.parentElement === slotRoot) {
    return existing
  }
  // A closed workspace's slot took its host out of the document; forget those boxes.
  for (const [id, host] of hosts) {
    if (!host.root.isConnected) {
      hosts.delete(id)
    }
  }
  const root = document.createElement('div')
  root.dataset.browserExtensionSidePanel = ''
  root.className =
    'absolute right-0 bottom-0 z-[2] flex min-h-0 flex-col border-l border-border bg-background'
  root.style.display = 'none'
  const chrome = document.createElement('div')
  chrome.className = 'shrink-0'
  const guests = document.createElement('div')
  guests.className = 'relative flex min-h-0 flex-1'
  root.append(chrome, guests)
  slotRoot.appendChild(root)
  const host = { root, chrome, guests }
  hosts.set(workspaceId, host)
  return host
}

function setPointerPassthrough(webview: Electron.WebviewTag, passthrough: boolean): void {
  webview.style.pointerEvents = passthrough ? 'none' : 'auto'
}

function createPanelWebview(panel: BrowserExtensionSidePanel, host: HTMLDivElement): PanelWebview {
  const webview = document.createElement('webview')
  webview.setAttribute('partition', panel.partition)
  // Why popups on: main routes the panel's window.open/target=_blank links to new tabs.
  webview.setAttribute('allowpopups', '')
  webview.setAttribute('webpreferences', ORCA_BROWSER_PAGE_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.className = 'absolute inset-0 flex h-full w-full border-none'
  webview.style.background = 'var(--background)'
  setPointerPassthrough(webview, isWebviewDragPassthroughActive())
  const stopPassthrough = registerWebviewDragPassthroughSurface((passthrough) =>
    setPointerPassthrough(webview, passthrough)
  )
  // Why handled here: Orca's guest preload turns window.close() into this message (a native close
  // would destroy the guest under the live <webview>); Chrome closes the panel.
  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === BROWSER_GUEST_WINDOW_CLOSE_CHANNEL) {
      void window.api.browser.extensionsSidePanelClose({ panelId: panel.id })
    }
  })
  host.appendChild(webview)
  let disposed = false
  void window.api.browser.extensionsSidePanelAttach({ panelId: panel.id }).then((marker) => {
    if (!disposed && marker) {
      webview.src = marker
    }
  })
  return {
    webview,
    host,
    dispose: () => {
      disposed = true
      stopPassthrough()
      webview.remove()
    }
  }
}

/** Shows the host beside the pages (they leave `width` free on their right), or hides it. */
export function layoutBrowserExtensionSidePanelHost(
  host: BrowserExtensionSidePanelHost,
  slotRoot: HTMLDivElement,
  layout: { width: string; top: number } | null
): void {
  if (layout) {
    slotRoot.style.setProperty(BROWSER_SIDE_PANEL_WIDTH_VARIABLE, layout.width)
    host.root.style.width = `var(${BROWSER_SIDE_PANEL_WIDTH_VARIABLE})`
    host.root.style.top = `${layout.top}px`
    host.root.style.display = 'flex'
  } else {
    slotRoot.style.removeProperty(BROWSER_SIDE_PANEL_WIDTH_VARIABLE)
    host.root.style.display = 'none'
  }
}

/**
 * Keeps one guest per open panel of this workspace and shows only `visibleId`. A panel's guest is
 * created the first time it shows: a <webview> that starts loading while hidden stays blank.
 */
export function syncBrowserExtensionSidePanelWebviews(
  host: BrowserExtensionSidePanelHost,
  panels: readonly BrowserExtensionSidePanel[],
  visibleId: string | null,
  canCreate: boolean
): void {
  const ids = new Set(panels.map((panel) => panel.id))
  for (const [id, entry] of webviews) {
    // Another workspace's panels are not in `panels`; a detached guest went with an old slot root.
    if (!entry.webview.isConnected || (entry.host === host.guests && !ids.has(id))) {
      entry.dispose()
      webviews.delete(id)
    }
  }
  for (const panel of panels) {
    let entry = webviews.get(panel.id)
    if (!entry && canCreate && panel.id === visibleId) {
      entry = createPanelWebview(panel, host.guests)
      webviews.set(panel.id, entry)
    }
    if (entry) {
      entry.webview.style.display = panel.id === visibleId ? 'flex' : 'none'
    }
  }
}
