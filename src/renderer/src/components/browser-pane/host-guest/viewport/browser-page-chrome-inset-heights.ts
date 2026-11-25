// Remember chrome insets across shell recovery/profile/slot rebuilds that do not trigger React remeasurement.
const heights = new Map<string, number>()
const MAX_REMEMBERED_BROWSER_PAGE_INSETS = 512
const listeners = new Set<(browserPageId: string) => void>()

export function getBrowserPageChromeInsetHeight(browserPageId: string): number | null {
  return heights.get(browserPageId) ?? null
}

/** Records a page's toolbar height and returns it clamped; listeners hear real changes only. */
export function rememberBrowserPageChromeInsetHeight(
  browserPageId: string,
  heightPx: number
): number {
  const insetHeight = Math.max(0, heightPx)
  const changed = heights.get(browserPageId) !== insetHeight
  heights.set(browserPageId, insetHeight)
  while (heights.size > MAX_REMEMBERED_BROWSER_PAGE_INSETS) {
    const oldest = heights.keys().next()
    if (oldest.done) {
      break
    }
    heights.delete(oldest.value)
  }
  if (changed) {
    for (const listener of listeners) {
      listener(browserPageId)
    }
  }
  return insetHeight
}

export function subscribeBrowserPageChromeInsets(
  listener: (browserPageId: string) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
