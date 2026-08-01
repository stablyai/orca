import type { PeersLayoutRect } from './peers-split-rects'
import type { PeersSplitSide } from './peers-split-tree'

export type PeersDockZone = PeersSplitSide

/** Fraction of the pane's axis size the nearest-edge band extends into. */
export const PEERS_DOCK_BAND_RATIO = 0.35

/**
 * Nearest edge of `paneRect` to `point`, or null when the point falls outside
 * the pane, outside every edge's band, or the drag started from that same pane
 * (dropping a tab onto its own pane is a no-op split).
 */
export function resolveDockZone(
  point: { x: number; y: number },
  paneRect: PeersLayoutRect,
  options?: { draggedLeafKey?: string | null; paneLeafKey?: string | null }
): PeersDockZone | null {
  if (
    options?.draggedLeafKey != null &&
    options.paneLeafKey != null &&
    options.draggedLeafKey === options.paneLeafKey
  ) {
    return null
  }
  const localX = point.x - paneRect.x
  const localY = point.y - paneRect.y
  if (localX < 0 || localX > paneRect.width || localY < 0 || localY > paneRect.height) {
    return null
  }
  const candidates: [PeersDockZone, number, number][] = [
    ['left', localX, paneRect.width],
    ['right', paneRect.width - localX, paneRect.width],
    ['top', localY, paneRect.height],
    ['bottom', paneRect.height - localY, paneRect.height]
  ]
  const [zone, distance, axisSize] = candidates.reduce((closest, candidate) =>
    candidate[1] < closest[1] ? candidate : closest
  )
  return distance <= axisSize * PEERS_DOCK_BAND_RATIO ? zone : null
}

/** Half of `paneRect` the docking overlay highlights for `zone`. */
export function dockZoneOverlayRect(
  paneRect: PeersLayoutRect,
  zone: PeersDockZone
): PeersLayoutRect {
  if (zone === 'left') {
    return { ...paneRect, width: paneRect.width / 2 }
  }
  if (zone === 'right') {
    return { ...paneRect, x: paneRect.x + paneRect.width / 2, width: paneRect.width / 2 }
  }
  if (zone === 'top') {
    return { ...paneRect, height: paneRect.height / 2 }
  }
  return { ...paneRect, y: paneRect.y + paneRect.height / 2, height: paneRect.height / 2 }
}
