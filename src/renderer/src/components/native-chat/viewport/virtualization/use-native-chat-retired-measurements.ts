import { useLayoutEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

/** Compact retired measurement keys before capped-transcript churn accumulates material stale state. */
export const MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS = 512

/** Drop the measurements of rows that left the transcript once enough of them pile up. */
export function useNativeChatRetiredMeasurements({
  itemKeys,
  scrollRef,
  virtualizer
}: {
  itemKeys: readonly string[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): void {
  const previousMeasurementKeysRef = useRef<ReadonlySet<string> | null>(null)
  const retiredMeasurementCountRef = useRef(0)
  useLayoutEffect(() => {
    const currentKeys = new Set(itemKeys)
    const previousKeys = previousMeasurementKeysRef.current
    previousMeasurementKeysRef.current = currentKeys
    if (previousKeys !== null) {
      for (const key of previousKeys) {
        if (!currentKeys.has(key)) {
          retiredMeasurementCountRef.current += 1
        }
      }
    }
    if (retiredMeasurementCountRef.current < MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS) {
      return
    }

    const retainedMeasurements = virtualizer
      .takeSnapshot()
      .filter((item) => typeof item.key === 'string' && currentKeys.has(item.key))
    const scrollTop = scrollRef.current?.scrollTop
    virtualizer.measure()
    // Materialize the estimate-only layout before restoring retained sizes.
    virtualizer.getTotalSize()
    for (const item of retainedMeasurements) {
      virtualizer.resizeItem(item.index, item.size)
    }
    if (scrollTop !== undefined) {
      virtualizer.scrollToOffset(scrollTop)
    }
    retiredMeasurementCountRef.current = 0
  }, [itemKeys, scrollRef, virtualizer])
}
