import { useCallback, useEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { STORY_END, STORY_LOOP } from './bots-fleet-story-timeline'

/** The story plays this many times, then rests on its finished frame. */
const LOOPS = 2
// Why: the frame only changes timers and bar widths; 30 renders a second reads as smooth.
const FRAME_MS = 1000 / 30

export type FleetStoryPlayback = {
  /** Seconds into the current loop. */
  t: number
  playing: boolean
  /** True once the last loop has rested on its finished frame. */
  finished: boolean
  reducedMotion: boolean
  togglePause: () => void
  replay: () => void
}

/** Drives the bots intro story while `active`; reduced motion shows only the finished frame. */
export function useBotsFleetStoryPlayback(active: boolean): FleetStoryPlayback {
  const reducedMotion = usePrefersReducedMotion()
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const elapsedRef = useRef(0)
  const total = STORY_LOOP * (LOOPS - 1) + STORY_END
  const finished = elapsed >= total
  const playing = active && !reducedMotion && !paused && !finished

  useEffect(() => {
    if (!playing) {
      return
    }
    let frameId = 0
    let last = performance.now()
    let lastPaint = last
    const tick = (now: number): void => {
      elapsedRef.current = Math.min(total, elapsedRef.current + (now - last) / 1000)
      last = now
      if (now - lastPaint >= FRAME_MS || elapsedRef.current >= total) {
        lastPaint = now
        setElapsed(elapsedRef.current)
      }
      if (elapsedRef.current < total) {
        frameId = requestAnimationFrame(tick)
      }
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [playing, total])

  const replay = useCallback(() => {
    elapsedRef.current = 0
    setElapsed(0)
    setPaused(false)
  }, [])

  const togglePause = useCallback(() => setPaused((value) => !value), [])

  const t = reducedMotion || finished ? STORY_END : elapsed % STORY_LOOP
  return {
    t,
    playing,
    finished: finished || reducedMotion,
    reducedMotion,
    togglePause,
    replay
  }
}
