/** A tab's on-screen x inside the strip viewport, recorded before tabs are inserted around it. */
export type TabStripScrollAnchor = {
  tabId: string
  offset: number
}

function tabElements(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'))
}

function findTab(strip: HTMLElement, tabId: string): HTMLElement | undefined {
  return tabElements(strip).find((tab) => tab.dataset.tabId === tabId)
}

/** The active tab when it is on screen, else the first visible tab; null when nothing is visible. */
export function captureTabStripScrollAnchor(
  strip: HTMLElement,
  activeTabId: string | null
): TabStripScrollAnchor | null {
  const stripRect = strip.getBoundingClientRect()
  const isVisible = (tab: HTMLElement): boolean => {
    const rect = tab.getBoundingClientRect()
    return rect.width > 0 && rect.right > stripRect.left && rect.left < stripRect.right
  }
  const active = activeTabId ? findTab(strip, activeTabId) : undefined
  const anchor =
    active && isVisible(active) ? active : tabElements(strip).find((tab) => isVisible(tab))
  const tabId = anchor?.dataset.tabId
  if (!anchor || !tabId) {
    return null
  }
  return { tabId, offset: anchor.getBoundingClientRect().left - stripRect.left }
}

/** Scroll so the anchor tab is back at its recorded x; false when that tab is gone. */
export function restoreTabStripScrollAnchor(
  strip: HTMLElement,
  anchor: TabStripScrollAnchor
): boolean {
  const tab = findTab(strip, anchor.tabId)
  if (!tab) {
    return false
  }
  const drift =
    tab.getBoundingClientRect().left - strip.getBoundingClientRect().left - anchor.offset
  if (drift !== 0) {
    strip.scrollLeft += drift
  }
  return true
}

export function isLastTabStripTab(strip: HTMLElement, tabId: string | null): boolean {
  return tabId !== null && tabElements(strip).at(-1)?.dataset.tabId === tabId
}
