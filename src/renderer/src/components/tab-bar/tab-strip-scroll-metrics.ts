import type { ActiveTabDockSide } from './tab-strip-slot-geometry'

export type TabStripOverflowState = {
  hasOverflow: boolean
  canScrollStart: boolean
  canScrollEnd: boolean
}

export type TabStripThumbLayout = {
  widthPx: number
  leftPx: number
}

type TabStripScrollBox = Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollLeft'>

export const TAB_STRIP_THUMB_MIN_WIDTH_PX = 18

const OVERFLOW_EPSILON_PX = 1

export function computeTabStripOverflowState(el: TabStripScrollBox): TabStripOverflowState {
  const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
  const hasOverflow = maxScrollLeft > OVERFLOW_EPSILON_PX

  return {
    hasOverflow,
    canScrollStart: hasOverflow && el.scrollLeft > OVERFLOW_EPSILON_PX,
    canScrollEnd: hasOverflow && el.scrollLeft < maxScrollLeft - OVERFLOW_EPSILON_PX
  }
}

export function computeTabStripThumbLayout(
  trackWidthPx: number,
  el: TabStripScrollBox
): TabStripThumbLayout {
  if (trackWidthPx <= 0) {
    return { widthPx: 0, leftPx: 0 }
  }

  const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
  const sizeFraction = el.scrollWidth > 0 ? Math.min(1, el.clientWidth / el.scrollWidth) : 1
  const offsetFraction = maxScrollLeft > OVERFLOW_EPSILON_PX ? el.scrollLeft / maxScrollLeft : 0
  const widthPx = Math.min(
    trackWidthPx,
    Math.max(TAB_STRIP_THUMB_MIN_WIDTH_PX, sizeFraction * trackWidthPx)
  )
  const maxLeftPx = Math.max(0, trackWidthPx - widthPx)

  return {
    widthPx,
    leftPx: offsetFraction * maxLeftPx
  }
}

/** `dockedSide` skips that edge's fade, which would otherwise wash out the active tab docked there. */
export function getTabStripScrollMaskClassName(
  metrics: TabStripOverflowState,
  dockedSide: ActiveTabDockSide | null = null
): string {
  if (!metrics.hasOverflow) {
    return ''
  }

  const classes: string[] = []
  if (metrics.canScrollStart && dockedSide !== 'start') {
    classes.push('terminal-tab-strip--fade-start')
  }
  if (metrics.canScrollEnd && dockedSide !== 'end') {
    classes.push('terminal-tab-strip--fade-end')
  }
  return classes.join(' ')
}

export function sameTabStripOverflowState(
  left: TabStripOverflowState,
  right: TabStripOverflowState
): boolean {
  return (
    left.hasOverflow === right.hasOverflow &&
    left.canScrollStart === right.canScrollStart &&
    left.canScrollEnd === right.canScrollEnd
  )
}
