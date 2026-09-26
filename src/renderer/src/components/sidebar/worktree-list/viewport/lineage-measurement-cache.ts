import type { MutableRefObject } from 'react'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'

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
