import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motionSafeScrollBehavior } from '@/hooks/theme/usePrefersReducedMotion'

const FACE_SIZE = 20
const FACE_GAP = 4
const FACE_STEP = FACE_SIZE + FACE_GAP
const TRACK_INSET = 4

export function useBotPreviewScroll(count: number, currentKey: string | undefined) {
  const previewRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(0)
  const [firstVisible, setFirstVisible] = useState(0)
  const badgeWidth = FACE_SIZE + Math.max(0, String(count).length - 2) * 6
  const overflow = width > 0 && count * FACE_STEP + TRACK_INSET > width
  const visibleCount = overflow
    ? Math.max(1, Math.floor((width - badgeWidth - FACE_GAP - TRACK_INSET) / FACE_STEP))
    : count
  const trackWidth = overflow ? visibleCount * FACE_STEP + TRACK_INSET : undefined

  useLayoutEffect(() => {
    const preview = previewRef.current
    if (!preview) {
      return
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(preview)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const track = trackRef.current
    const current = track?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!track || !current || !overflow) {
      return
    }
    const start = current.offsetLeft - TRACK_INSET
    const end = current.offsetLeft + current.offsetWidth + TRACK_INSET
    if (start < track.scrollLeft) {
      track.scrollLeft = start
    } else if (end > track.scrollLeft + track.clientWidth) {
      track.scrollLeft = end - track.clientWidth
    }
  }, [currentKey, overflow, trackWidth])

  useEffect(() => {
    const track = trackRef.current
    const header = previewRef.current?.parentElement
    if (!track || !header || !overflow) {
      return
    }
    // Accumulate wheel ticks against the destination while Chromium animates the strip.
    let destination: number | null = null
    const onScrollEnd = (): void => {
      destination = null
      setFirstVisible(Math.round(track.scrollLeft / FACE_STEP))
    }
    const onWheel = (event: WheelEvent): void => {
      if (!event.cancelable || event.ctrlKey || event.metaKey) {
        return
      }
      const mode = event.deltaMode
      const { deltaX, deltaY } = event
      const horizontal = Math.abs(deltaX) >= Math.abs(deltaY)
      if (horizontal && event.target instanceof Node && track.contains(event.target)) {
        destination = null
        return
      }
      const unit = mode === WheelEvent.DOM_DELTA_LINE ? FACE_STEP : track.clientWidth
      const delta =
        (horizontal ? deltaX : deltaY) * (mode === WheelEvent.DOM_DELTA_PIXEL ? 1 : unit)
      const left = track.scrollLeft
      const max = track.scrollWidth - track.clientWidth
      // Reversing direction should act on the current position, even mid-animation.
      const base = destination !== null && (destination - left) * delta > 0 ? destination : left
      const next = Math.min(max, Math.max(0, base + delta))
      if (next === left) {
        return
      }
      event.preventDefault()
      destination = next
      track.scrollTo({ left: next, behavior: motionSafeScrollBehavior() })
    }

    onScrollEnd()
    track.addEventListener('scrollend', onScrollEnd)
    header.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      track.removeEventListener('scrollend', onScrollEnd)
      header.removeEventListener('wheel', onWheel)
    }
  }, [overflow])

  return {
    previewRef,
    trackRef,
    trackWidth,
    badgeWidth,
    visibleCount,
    firstVisible: Math.min(Math.max(0, count - visibleCount), firstVisible)
  }
}
