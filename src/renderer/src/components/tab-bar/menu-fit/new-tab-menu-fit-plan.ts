export type NewTabMenuFitMode = 'fit' | 'peek' | 'menu'

export type NewTabMenuFitPlan = {
  tipHidden: boolean
  /** fit: the list shows whole; peek: the list scrolls with a half row showing; menu: the whole menu scrolls. */
  mode: NewTabMenuFitMode
  listMaxHeight: number | null
}

export const NEW_TAB_MENU_LIST_MAX_ROWS = 12
const MIN_PEEK_ROWS = 2.5

/**
 * Sizes the + menu's agent list to the room Radix gives the menu. Yield order: hide the tip,
 * shrink the list to a 2.5-row peek, then hand scrolling to the whole menu.
 */
export function planNewTabMenuFit({
  available,
  chrome,
  tip,
  natural,
  row,
  maxRows = NEW_TAB_MENU_LIST_MAX_ROWS
}: {
  /** Height Radix allows the menu on the side it opened. */
  available: number
  /** Everything in the menu but the list and the tip. */
  chrome: number
  /** The tip's footprint; 0 when there is no tip to show. */
  tip: number
  /** The list's full content height. */
  natural: number
  row: number
  maxRows?: number
}): NewTabMenuFitPlan {
  const minPeek = MIN_PEEK_ROWS * row
  const cap = (space: number): number => Math.min(space, maxRows * row)
  const peek = (space: number): number =>
    Math.max(minPeek, (Math.floor(cap(space) / row) - 0.5) * row)
  const withTip = available - chrome - tip
  if (natural <= cap(withTip)) {
    return { tipHidden: false, mode: 'fit', listMaxHeight: cap(withTip) }
  }
  if (cap(withTip) >= minPeek) {
    return { tipHidden: false, mode: 'peek', listMaxHeight: peek(withTip) }
  }
  const space = available - chrome
  if (natural <= cap(space)) {
    return { tipHidden: true, mode: 'fit', listMaxHeight: cap(space) }
  }
  if (cap(space) >= minPeek) {
    return { tipHidden: true, mode: 'peek', listMaxHeight: peek(space) }
  }
  return { tipHidden: true, mode: 'menu', listMaxHeight: null }
}

export function sameNewTabMenuFitPlan(a: NewTabMenuFitPlan, b: NewTabMenuFitPlan): boolean {
  return a.tipHidden === b.tipHidden && a.mode === b.mode && a.listMaxHeight === b.listMaxHeight
}

/** Bottom scroll padding so keyboard focus never rests under the 16px fade. */
export function fadeScrollPadding(row: number): number {
  return 16 + row / 2
}
