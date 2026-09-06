import { useLayoutEffect, useRef } from 'react'
import type { PaneSize } from './emulator-device-frame-layout'

export function useCenterAnchoredEmulatorScroll(
  viewportSize: PaneSize | null,
  contentSize: PaneSize | null
): React.RefObject<HTMLDivElement | null> {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousContentSizeRef = useRef<PaneSize | null>(null)

  useLayoutEffect(() => {
    const node = scrollRef.current
    const previous = previousContentSizeRef.current
    previousContentSizeRef.current = contentSize
    if (!node || !contentSize || !viewportSize) {
      return
    }
    if (!previous) {
      return
    }

    const centerX =
      previous.width <= viewportSize.width
        ? 0.5
        : (node.scrollLeft + viewportSize.width / 2) / previous.width
    const centerY =
      previous.height <= viewportSize.height
        ? 0.5
        : (node.scrollTop + viewportSize.height / 2) / previous.height
    node.scrollLeft = clamp(
      centerX * contentSize.width - viewportSize.width / 2,
      0,
      node.scrollWidth - node.clientWidth
    )
    node.scrollTop = clamp(
      centerY * contentSize.height - viewportSize.height / 2,
      0,
      node.scrollHeight - node.clientHeight
    )
  }, [contentSize, viewportSize])

  return scrollRef
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
