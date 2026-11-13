// A scroll request for one window tab; the mounted terminal or chat that shows it answers synchronously.
export const SCROLL_SESSION_TAB_EVENT = 'orca-scroll-session-tab'

export type ScrollSessionTabDetail = {
  tabId: string
  /** Terminal split leaf; null scrolls the tab's active pane. Chat tabs ignore it. */
  leafId: string | null
  /** CSS pixels; positive scrolls toward the latest output. */
  deltaY: number
  /** Set by the surface that scrolled. */
  scrolled: boolean
}

export function requestSessionTabScroll(
  tabId: string,
  leafId: string | null,
  deltaY: number
): boolean {
  const detail: ScrollSessionTabDetail = { tabId, leafId, deltaY, scrolled: false }
  window.dispatchEvent(new CustomEvent(SCROLL_SESSION_TAB_EVENT, { detail }))
  return detail.scrolled
}

/** Subscribes a surface to scroll requests for its tab; `scroll` returns whether anything moved. */
export function onSessionTabScroll(
  tabId: string,
  scroll: (detail: ScrollSessionTabDetail) => boolean
): () => void {
  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return
    }
    const detail: ScrollSessionTabDetail | null = event.detail
    if (detail && !detail.scrolled && detail.tabId === tabId && scroll(detail)) {
      detail.scrolled = true
    }
  }
  window.addEventListener(SCROLL_SESSION_TAB_EVENT, listener)
  return () => window.removeEventListener(SCROLL_SESSION_TAB_EVENT, listener)
}
