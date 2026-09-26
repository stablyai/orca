import type { MutableRefObject } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import {
  ESTIMATED_LINEAGE_CARD_HEIGHT,
  type LineageVirtualTree
} from '../listing/lineage-virtual-tree'

// A restored pixel anchor needs the same estimates after the sidebar body remounts.
const caches = new WeakMap<MutableRefObject<VirtualizedScrollAnchor>, Map<string, number>>()

export function getLineageMeasurementCache(
  anchorRef: MutableRefObject<VirtualizedScrollAnchor>
): Map<string, number> {
  let cache = caches.get(anchorRef)
  if (!cache) {
    cache = new Map()
    caches.set(anchorRef, cache)
  }
  return cache
}

export function getInitialLineageMeasurements(
  tree: LineageVirtualTree,
  measuredHeights: ReadonlyMap<string, number>,
  scrollMargin: number
): VirtualItem[] {
  const measurements: VirtualItem[] = []
  if (measuredHeights.size === 0) {
    return measurements
  }
  let start = scrollMargin
  for (const [index, node] of tree.nodes.entries()) {
    const key = node.row.rowKey
    const measured = measuredHeights.get(key)
    const size = measured ?? ESTIMATED_LINEAGE_CARD_HEIGHT
    if (measured !== undefined) {
      measurements.push({ key, index, start, size, end: start + size, lane: 0 })
    }
    start += size
  }
  return measurements
}
