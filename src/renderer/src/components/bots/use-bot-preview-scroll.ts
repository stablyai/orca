import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { motionSafeScrollBehavior } from '@/hooks/theme/usePrefersReducedMotion'

const FACE_SIZE = 20
const FACE_GAP = 4
const FACE_STEP = FACE_SIZE + FACE_GAP
const TRACK_INSET = 4
const EDGE_WIDTH = 12
export const PREVIEW_TRACK_HEIGHT = FACE_SIZE + TRACK_INSET * 2

export function botPreviewFaceStart(index: number): number {
  return TRACK_INSET + index * FACE_STEP
}

function readTrackBounds(track: HTMLElement) {
  const width = track.clientWidth
  const max = Math.max(0, track.scrollWidth - width)
  const left = Math.max(0, Math.min(max, track.scrollLeft))
  const right = left + width
  return {
    left,
    right,
    max,
    clearLeft: left + (left > 0 ? EDGE_WIDTH : TRACK_INSET),
    clearRight: right - (left < max ? EDGE_WIDTH : 0)
  }
}

export function useBotPreviewScroll(
  count: number,
  current: { key: string; index: number } | undefined
) {
  const previewRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(0)
  const [range, setRange] = useState({ first: 0, end: 0, firstFull: 0, endFull: 0 })
  const totalWidth = count > 0 ? count * FACE_STEP + TRACK_INSET : 0
  const overflow = width > 0 && totalWidth > width
  const trackWidth = overflow
    ? Math.min(
        width,
        Math.max(0, Math.floor((width - TRACK_INSET - EDGE_WIDTH) / FACE_STEP)) * FACE_STEP +
          TRACK_INSET +
          EDGE_WIDTH
      )
    : Math.min(width, totalWidth)

  const syncWindow = useCallback((): void => {
    const track = trackRef.current
    if (!track) {
      return
    }
    const { left, right, clearLeft, clearRight } = readTrackBounds(track)
    const first = Math.floor(left / FACE_STEP)
    const end = Math.ceil((right - TRACK_INSET) / FACE_STEP)
    const firstFull = Math.ceil((clearLeft - TRACK_INSET) / FACE_STEP)
    const endFull = Math.max(0, Math.floor((clearRight - TRACK_INSET) / FACE_STEP))
    setRange((previous) =>
      previous.first === first &&
      previous.end === end &&
      previous.firstFull === firstFull &&
      previous.endFull === endFull
        ? previous
        : { first, end, firstFull, endFull }
    )
  }, [])

  useLayoutEffect(() => {
    const preview = previewRef.current
    if (!preview) {
      return
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(preview)
    return () => observer.disconnect()
  }, [])

  const revealAvatar = useCallback(
    (index: number): void => {
      const track = trackRef.current
      if (!track) {
        return
      }
      const { clearLeft, clearRight } = readTrackBounds(track)
      const start = botPreviewFaceStart(index)
      const end = start + FACE_SIZE + TRACK_INSET
      if (start < clearLeft) {
        track.scrollLeft = start - EDGE_WIDTH
      } else if (end > clearRight) {
        track.scrollLeft = end + EDGE_WIDTH - track.clientWidth
      }
      syncWindow()
    },
    [syncWindow]
  )

  const revealCurrent = useEffectEvent(() => {
    if (current) {
      revealAvatar(current.index)
    }
  })
  const currentKey = current?.key
  useLayoutEffect(() => {
    if (overflow && currentKey !== undefined) {
      revealCurrent()
    }
  }, [currentKey, overflow, trackWidth])

  useLayoutEffect(syncWindow, [syncWindow, trackWidth, totalWidth])

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

    track.addEventListener('scrollend', onScrollEnd)
    header.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      track.removeEventListener('scrollend', onScrollEnd)
      header.removeEventListener('wheel', onWheel)
    }
  }, [overflow])

  function pageBots(direction: -1 | 1, keyboard: boolean): boolean {
    const track = trackRef.current
    if (!track) {
      return false
    }
    const { left, max } = readTrackBounds(track)
    const step = Math.max(1, Math.floor(track.clientWidth / FACE_STEP) - 1) * FACE_STEP
    const target = Math.max(0, Math.min(max, left + step * direction))
    track.scrollTo({
      left: target,
      behavior: keyboard ? 'instant' : motionSafeScrollBehavior()
    })
    if (keyboard) {
      syncWindow()
    }
    return direction === -1 ? target === 0 : target === max
  }

  return {
    previewRef,
    trackRef,
    trackWidth,
    totalWidth,
    overflow,
    before: overflow ? Math.min(count, range.firstFull) : 0,
    after: overflow ? Math.max(0, count - range.endFull) : 0,
    firstVisible: overflow ? Math.min(count, range.first) : 0,
    endVisible: overflow ? Math.min(count, range.end) : width > 0 ? count : 0,
    firstFull: overflow ? range.firstFull : 0,
    endFull: overflow ? range.endFull : count,
    syncWindow,
    revealAvatar,
    pageBots
  }
}
