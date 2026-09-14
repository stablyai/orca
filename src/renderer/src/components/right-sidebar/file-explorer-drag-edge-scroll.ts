// Native drag auto-scroll uses a very thin band; a wider zone matches IDE-style
// tree dragging so users need not hug the scrollbar.
export const DRAG_EDGE_ZONE_PX = 48

export function getDragEdgeScrollTarget({
  scrollTop,
  scrollHeight,
  clientHeight,
  localY,
  edgeZonePx = DRAG_EDGE_ZONE_PX
}: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  localY: number
  edgeZonePx?: number
}): number | null {
  let delta = 0
  if (localY < edgeZonePx) {
    const strength = (edgeZonePx - localY) / edgeZonePx
    delta = -(1.25 + strength * 9)
  } else if (localY > clientHeight - edgeZonePx) {
    const strength = (localY - (clientHeight - edgeZonePx)) / edgeZonePx
    delta = 1.25 + strength * 9
  }

  if (delta === 0) {
    return null
  }

  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  const nextScrollTop = Math.max(0, Math.min(maxScroll, scrollTop + delta))
  return nextScrollTop === scrollTop ? null : nextScrollTop
}
