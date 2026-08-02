import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  computeTabStripThumbLayout,
  type TabStripScrollMetrics,
  type TabStripThumbLayout
} from './tab-strip-scroll-metrics'

const EMPTY_THUMB_LAYOUT: TabStripThumbLayout = { widthPx: 0, leftPx: 0 }

export function TabStripScrollIndicator({
  metrics
}: {
  metrics: TabStripScrollMetrics
}): React.JSX.Element | null {
  const trackRef = useRef<HTMLDivElement>(null)
  const [thumbLayout, setThumbLayout] = useState<TabStripThumbLayout>(EMPTY_THUMB_LAYOUT)

  const remeasureThumb = useCallback((): void => {
    const track = trackRef.current
    if (!track) {
      return
    }
    setThumbLayout(computeTabStripThumbLayout(track.clientWidth, metrics))
  }, [metrics])

  useLayoutEffect(() => {
    remeasureThumb()
  }, [remeasureThumb])

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) {
      return
    }
    const resizeObserver = new ResizeObserver(remeasureThumb)
    resizeObserver.observe(track)
    return () => resizeObserver.disconnect()
  }, [remeasureThumb])

  if (!metrics.hasOverflow) {
    return null
  }

  return (
    // Why: top rail keeps the active tab's bottom underline unobstructed.
    <div
      ref={trackRef}
      className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-px bg-muted-foreground/10"
      aria-hidden
    >
      <div
        className="absolute top-0 h-full rounded-full bg-muted-foreground/40 transition-[left,width] duration-75 ease-out"
        style={{
          width: `${thumbLayout.widthPx}px`,
          left: `${thumbLayout.leftPx}px`
        }}
      />
    </div>
  )
}
