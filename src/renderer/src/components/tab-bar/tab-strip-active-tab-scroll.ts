export const TAB_STRIP_TAB_ID_SELECTOR = '[data-tab-id]'
export const TAB_STRIP_END_PAD_ATTR = 'data-tab-strip-end-pad'

// Why: matches the 1.5rem fade mask so nearest-reveal keeps the close control out of the fade.
export const TAB_STRIP_REVEAL_INSET_PX = 24

export function findLastTabStripTab(strip: ParentNode): HTMLElement | null {
  const tabs = strip.querySelectorAll<HTMLElement>(TAB_STRIP_TAB_ID_SELECTOR)
  return [...tabs].at(-1) ?? null
}

export function isLastTabStripTab(strip: ParentNode, tab: Element): boolean {
  return findLastTabStripTab(strip) === tab
}

export function computeTabStripEndInset({
  stripClientWidth,
  lastTabWidth,
  contentWidth
}: {
  stripClientWidth: number
  lastTabWidth: number
  contentWidth: number
}): number {
  if (stripClientWidth <= 0 || lastTabWidth <= 0 || contentWidth <= stripClientWidth) {
    return 0
  }
  // Why: a half-viewport pad centered the last tab but hid earlier tabs and
  // created a drop dead-zone; a fade-sized inset keeps the close control clear.
  // Trade-off: a center request only lands centered while the strip is within
  // 2x this inset of the last tab's width; wider gaps settle at end + inset.
  return Math.min(TAB_STRIP_REVEAL_INSET_PX, Math.max(0, stripClientWidth - lastTabWidth))
}

export function computeTabStripScrollLeft({
  stripScrollWidth,
  stripClientWidth,
  stripScrollLeft,
  tabOffsetLeft,
  tabWidth,
  inline
}: {
  stripScrollWidth: number
  stripClientWidth: number
  stripScrollLeft: number
  tabOffsetLeft: number
  tabWidth: number
  inline: 'nearest' | 'center'
}): number {
  const maxScrollLeft = Math.max(0, stripScrollWidth - stripClientWidth)
  if (inline === 'center') {
    return clamp(tabOffsetLeft + tabWidth / 2 - stripClientWidth / 2, 0, maxScrollLeft)
  }

  const tabStart = tabOffsetLeft
  const tabEnd = tabOffsetLeft + tabWidth
  const viewStart = stripScrollLeft + TAB_STRIP_REVEAL_INSET_PX
  const viewEnd = stripScrollLeft + stripClientWidth - TAB_STRIP_REVEAL_INSET_PX
  if (tabStart >= viewStart && tabEnd <= viewEnd) {
    return stripScrollLeft
  }
  if (tabEnd > viewEnd) {
    return clamp(tabEnd - stripClientWidth + TAB_STRIP_REVEAL_INSET_PX, 0, maxScrollLeft)
  }
  return clamp(tabStart - TAB_STRIP_REVEAL_INSET_PX, 0, maxScrollLeft)
}

export function syncTabStripEndPad(strip: HTMLElement): number {
  const lastTab = findLastTabStripTab(strip)
  const pad = computeTabStripEndInset({
    stripClientWidth: strip.clientWidth,
    lastTabWidth: lastTab?.offsetWidth ?? 0,
    contentWidth: lastTab ? lastTab.offsetLeft + lastTab.offsetWidth : 0
  })
  const spacer = strip.querySelector<HTMLElement>(`[${TAB_STRIP_END_PAD_ATTR}]`)
  if (spacer) {
    const nextWidth = `${pad}px`
    if (spacer.style.width !== nextWidth) {
      spacer.style.width = nextWidth
    }
  }
  return pad
}

export function scrollTabStripTabIntoView(
  strip: HTMLElement,
  tab: HTMLElement,
  inline: 'nearest' | 'center'
): void {
  strip.scrollLeft = computeTabStripScrollLeft({
    stripScrollWidth: strip.scrollWidth,
    stripClientWidth: strip.clientWidth,
    stripScrollLeft: strip.scrollLeft,
    tabOffsetLeft: tab.offsetLeft,
    tabWidth: tab.offsetWidth,
    inline
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
