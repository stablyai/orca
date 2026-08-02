export type TabStripScrollMetrics = {
  hasOverflow: boolean
  canScrollStart: boolean
  canScrollEnd: boolean
  /** Portion of total tab width currently visible in the strip viewport. */
  thumbSizeFraction: number
  /** 0 = scrolled to start, 1 = scrolled to end. */
  thumbOffsetFraction: number
}

export type TabStripThumbLayout = {
  widthPx: number
  leftPx: number
}

export const TAB_STRIP_THUMB_MIN_WIDTH_PX = 18

const OVERFLOW_EPSILON_PX = 1

export function computeTabStripScrollMetrics(
  el: Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollLeft'>
): TabStripScrollMetrics {
  const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
  const hasOverflow = maxScrollLeft > OVERFLOW_EPSILON_PX
  const thumbSizeFraction = el.scrollWidth > 0 ? Math.min(1, el.clientWidth / el.scrollWidth) : 1
  const thumbOffsetFraction = hasOverflow && maxScrollLeft > 0 ? el.scrollLeft / maxScrollLeft : 0

  return {
    hasOverflow,
    canScrollStart: hasOverflow && el.scrollLeft > OVERFLOW_EPSILON_PX,
    canScrollEnd: hasOverflow && el.scrollLeft < maxScrollLeft - OVERFLOW_EPSILON_PX,
    thumbSizeFraction,
    thumbOffsetFraction
  }
}

export function computeTabStripThumbLayout(
  trackWidthPx: number,
  metrics: Pick<TabStripScrollMetrics, 'thumbSizeFraction' | 'thumbOffsetFraction'>
): TabStripThumbLayout {
  if (trackWidthPx <= 0) {
    return { widthPx: 0, leftPx: 0 }
  }

  const rawWidthPx = metrics.thumbSizeFraction * trackWidthPx
  const widthPx = Math.min(trackWidthPx, Math.max(TAB_STRIP_THUMB_MIN_WIDTH_PX, rawWidthPx))
  const maxLeftPx = Math.max(0, trackWidthPx - widthPx)

  return {
    widthPx,
    leftPx: metrics.thumbOffsetFraction * maxLeftPx
  }
}

export function getTabStripScrollMaskClassName(
  metrics: Pick<TabStripScrollMetrics, 'canScrollStart' | 'canScrollEnd' | 'hasOverflow'>
): string {
  if (!metrics.hasOverflow) {
    return ''
  }

  const classes: string[] = []
  if (metrics.canScrollStart) {
    classes.push('terminal-tab-strip--fade-start')
  }
  if (metrics.canScrollEnd) {
    classes.push('terminal-tab-strip--fade-end')
  }
  return classes.join(' ')
}

export function sameTabStripScrollMetrics(
  left: TabStripScrollMetrics,
  right: TabStripScrollMetrics
): boolean {
  return (
    left.hasOverflow === right.hasOverflow &&
    left.canScrollStart === right.canScrollStart &&
    left.canScrollEnd === right.canScrollEnd &&
    Math.abs(left.thumbSizeFraction - right.thumbSizeFraction) < 0.002 &&
    Math.abs(left.thumbOffsetFraction - right.thumbOffsetFraction) < 0.002
  )
}
