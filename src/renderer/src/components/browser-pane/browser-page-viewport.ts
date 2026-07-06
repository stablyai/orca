// Why: Electron <webview> guests are destroyed when their DOM parent is removed.
// BrowserPane chrome unmounts on worktree switch, but the guest must stay in a
// stable parent inside the overlay slot. Each page gets a flex-column viewport
// (chrome inset spacer + flex-1 container) that mirrors the in-tree layout
// without reparenting the webview or using fixed/float-over positioning.

const slotViewportRoots = new Map<string, HTMLDivElement>()

type BrowserPageViewport = {
  shell: HTMLDivElement
  chromeInset: HTMLDivElement
  container: HTMLDivElement
}

const browserPageViewports = new Map<string, BrowserPageViewport>()

const slotRootListeners = new Map<string, Set<() => void>>()

function notifySlotRootListeners(workspaceTabId: string): void {
  for (const listener of slotRootListeners.get(workspaceTabId) ?? []) {
    listener()
  }
}

export function registerBrowserOverlaySlotViewport(
  workspaceTabId: string,
  element: HTMLDivElement | null
): void {
  if (element) {
    slotViewportRoots.set(workspaceTabId, element)
    notifySlotRootListeners(workspaceTabId)
    return
  }
  slotViewportRoots.delete(workspaceTabId)
  slotRootListeners.delete(workspaceTabId)
}

export function getBrowserOverlaySlotViewport(workspaceTabId: string): HTMLDivElement | null {
  return slotViewportRoots.get(workspaceTabId) ?? null
}

export function subscribeBrowserOverlaySlotViewport(
  workspaceTabId: string,
  listener: () => void
): () => void {
  let listeners = slotRootListeners.get(workspaceTabId)
  if (!listeners) {
    listeners = new Set()
    slotRootListeners.set(workspaceTabId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) {
      slotRootListeners.delete(workspaceTabId)
    }
  }
}

export function getBrowserPageViewportContainer(browserPageId: string): HTMLDivElement | null {
  return browserPageViewports.get(browserPageId)?.container ?? null
}

export function ensureBrowserPageViewport(
  browserPageId: string,
  workspaceTabId: string
): BrowserPageViewport | null {
  const existing = browserPageViewports.get(browserPageId)
  if (existing) {
    return existing
  }
  const root = slotViewportRoots.get(workspaceTabId)
  if (!root) {
    return null
  }
  const shell = document.createElement('div')
  shell.dataset.browserPageViewportId = browserPageId
  shell.className = 'absolute inset-0 flex min-h-0 flex-col'
  shell.style.display = 'none'
  shell.inert = true
  shell.setAttribute('aria-hidden', 'true')

  const chromeInset = document.createElement('div')
  chromeInset.dataset.browserPageChromeInset = ''
  chromeInset.className = 'shrink-0'

  const container = document.createElement('div')
  container.dataset.browserPageContainer = ''
  container.className = 'relative flex min-h-0 flex-1 overflow-hidden bg-background'

  shell.append(chromeInset, container)
  root.appendChild(shell)

  const viewport = { shell, chromeInset, container }
  browserPageViewports.set(browserPageId, viewport)
  return viewport
}

export function removeBrowserPageViewport(browserPageId: string): void {
  const viewport = browserPageViewports.get(browserPageId)
  if (viewport) {
    viewport.shell.remove()
    browserPageViewports.delete(browserPageId)
  }
}

export type BrowserPageViewportLayout = {
  paintable: boolean
  active: boolean
}

export function applyBrowserPageViewportLayout(
  browserPageId: string,
  layout: BrowserPageViewportLayout
): void {
  const viewport = browserPageViewports.get(browserPageId)
  if (!viewport) {
    return
  }
  if (!layout.paintable) {
    viewport.shell.style.display = 'none'
    viewport.shell.inert = true
    viewport.shell.setAttribute('aria-hidden', 'true')
    return
  }
  viewport.shell.inert = !layout.active
  if (layout.active) {
    viewport.shell.removeAttribute('aria-hidden')
  } else {
    viewport.shell.setAttribute('aria-hidden', 'true')
  }
  viewport.shell.style.display = 'flex'
  viewport.shell.style.opacity = layout.active ? '1' : '0'
  viewport.shell.style.pointerEvents = layout.active ? 'auto' : 'none'
  viewport.shell.style.zIndex = layout.active ? '1' : '0'
}

export function syncBrowserPageChromeInset(browserPageId: string, heightPx: number): void {
  const viewport = browserPageViewports.get(browserPageId)
  if (!viewport) {
    return
  }
  viewport.chromeInset.style.height = `${Math.max(0, heightPx)}px`
}

export function parkBrowserPageViewport(browserPageId: string): void {
  const viewport = browserPageViewports.get(browserPageId)
  if (viewport) {
    viewport.shell.style.display = 'none'
    viewport.shell.inert = true
    viewport.shell.setAttribute('aria-hidden', 'true')
    viewport.shell.style.pointerEvents = 'none'
    viewport.shell.style.opacity = '0'
  }
}
