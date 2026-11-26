type Span = { left: number; right: number }

/** Keeps the 7px arrow clear of the callout's rounded corners. */
const MIN_ARROW_INSET = 12

/**
 * Where the tip's arrow centre sits, in the callout's local px from its inline-start padding edge.
 * Rects are viewport px, so they are divided by the menu's open-animation scale.
 */
export function introArrowInset({
  callout,
  borderStart,
  width,
  iconCenter,
  view,
  scale,
  rtl
}: {
  /** Callout border box, viewport px. */
  callout: Span
  /** Inline-start border width, local px. */
  borderStart: number
  /** Callout padding-box width, local px. */
  width: number
  /** Phone icon centre x, viewport px. */
  iconCenter: number
  /** The icon row's visible box, viewport px. */
  view: Span
  scale: number
  rtl: boolean
}): { inset: number; visible: boolean } {
  const fromStart = rtl ? callout.right - iconCenter : iconCenter - callout.left
  const inset = fromStart / scale - borderStart
  return {
    inset: Math.min(Math.max(inset, MIN_ARROW_INSET), width - MIN_ARROW_INSET),
    visible: iconCenter >= view.left && iconCenter <= view.right
  }
}

/** Physical scrollLeft change that brings the icon clear of the row's edge fades; 0 if it already is. */
export function revealScrollDelta({
  item,
  view,
  margin,
  scale
}: {
  item: Span
  view: Span
  /** The row's edge-fade width, local px. */
  margin: number
  scale: number
}): number {
  const start = view.left + margin * scale
  const end = view.right - margin * scale
  if (item.left < start) {
    return (item.left - start) / scale
  }
  if (item.right > end) {
    return (item.right - end) / scale
  }
  return 0
}
