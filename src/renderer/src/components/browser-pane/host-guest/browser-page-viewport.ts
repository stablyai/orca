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

// Why: React measures the chrome only on mount, but shells are rebuilt without a
// re-measure (guest recovery/replacement, profile switch, slot remount). Remembering
// the inset keeps geometry a property of attaching a guest, not of the first mount.
const browserPageChromeInsetHeights = new Map<string, number>()

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
  // Why: subscribers outlive the root they watch — dropping them here would leave a
  // remounted slot with live components that never hear about the new root.
  notifySlotRootListeners(workspaceTabId)
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
  const ownedListeners = listeners
  ownedListeners.add(listener)
  return () => {
    ownedListeners.delete(listener)
    // Why: only drop the map entry this unsubscribe still owns; a replacement Set
    // may already be registered for the same tab.
    if (ownedListeners.size === 0 && slotRootListeners.get(workspaceTabId) === ownedListeners) {
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
  const root = slotViewportRoots.get(workspaceTabId)
  const existing = browserPageViewports.get(browserPageId)
  if (existing) {
    if (!root || existing.shell.parentElement === root) {
      return existing
    }
    // Why: a remounted slot strands this shell after Electron destroys its detached guest (STA-3228).
    existing.shell.remove()
    browserPageViewports.delete(browserPageId)
  }
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
  const rememberedInsetHeight = browserPageChromeInsetHeights.get(browserPageId)
  if (rememberedInsetHeight !== undefined) {
    chromeInset.style.height = `${rememberedInsetHeight}px`
  }

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
  const insetHeight = Math.max(0, heightPx)
  browserPageChromeInsetHeights.set(browserPageId, insetHeight)
  const viewport = browserPageViewports.get(browserPageId)
  if (!viewport) {
    return
  }
  viewport.chromeInset.style.height = `${insetHeight}px`
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
