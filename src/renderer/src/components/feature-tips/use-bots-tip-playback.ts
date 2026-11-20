import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import {
  BOTS_TIP_PAGE_COUNT,
  BOTS_TIP_PAGE_END,
  BOTS_TIP_PAGE_HOLD,
  botsTipFrameIsContinuous,
  nextBotsTipCue
} from './bots-tip-timeline'

// Why: CSS transitions carry the motion between cues, so the card renders only when a cue lands;
// a render per frame for the card's whole life kept the renderer's Blink heap climbing until GC.
const FRAME_MS = 1000 / 30
// Why: frames stop while the window is hidden; on return the clock resumes where it was instead of
// jumping by the whole gap and skipping a page.
const MAX_STEP_MS = 100

export type BotsTipPlayback = {
  page: number
  /** Seconds into the current page, held at its end frame. */
  t: number
  /** Each page's frame: the current page's `t`, the others where they were left. */
  pageTimes: readonly number[]
  /** Seconds the current page plays, its hold included: the progress pill's fill duration. */
  pageSeconds: number
  /** Seconds into that span at this render; the pill's CSS animation resumes from here. */
  pageElapsed: number
  /** False while paused (reduced motion, closed or window hidden): the pill stays where it is. */
  playing: boolean
  /** Counts page starts, so a page shown again restarts its one-shot pieces. */
  visit: number
  /** How many times each page has started. */
  pageStarts: readonly number[]
  reducedMotion: boolean
  goTo: (page: number) => void
}

type Pages = { page: number; visit: number; left: readonly number[]; starts: readonly number[] }

function endOf(page: number): number {
  return BOTS_TIP_PAGE_END[page] ?? 0
}

function nextPages(state: Pages, go: { page: number; leftAt: number }): Pages {
  const left = [...state.left]
  left[state.page] = Math.min(go.leftAt, endOf(state.page))
  const page = ((go.page % BOTS_TIP_PAGE_COUNT) + BOTS_TIP_PAGE_COUNT) % BOTS_TIP_PAGE_COUNT
  const starts = [...state.starts]
  starts[page] = (starts[page] ?? 0) + 1
  return { page, visit: state.visit + 1, left, starts }
}

/**
 * Plays the pages while `active`: each runs its animation, holds its end frame, then the next page
 * starts (after the last, the first). A jump restarts the clock on that page and keeps cycling.
 * Reduced motion shows every page's end frame and moves only when asked.
 */
export function useBotsTipPlayback(active: boolean): BotsTipPlayback {
  const reducedMotion = usePrefersReducedMotion()
  const [{ page, visit, left, starts }, go] = useReducer(nextPages, {
    page: 0,
    visit: 0,
    left: BOTS_TIP_PAGE_END.map(() => 0),
    starts: BOTS_TIP_PAGE_END.map((_, index) => (index === 0 ? 1 : 0))
  })
  const [elapsed, setElapsed] = useState(0)
  const elapsedRef = useRef(0)
  const playing = active && !reducedMotion

  const goTo = useCallback((next: number) => {
    go({ page: next, leftAt: elapsedRef.current })
    elapsedRef.current = 0
    setElapsed(0)
  }, [])

  useEffect(() => {
    // Pausing or resuming publishes the clock, so the progress pill restarts from where the page is.
    setElapsed(elapsedRef.current)
    if (!playing) {
      return
    }
    const total = endOf(page) + BOTS_TIP_PAGE_HOLD
    let frameId = 0
    let last = performance.now()
    let lastPaint = last
    let nextCue = nextBotsTipCue(page, elapsedRef.current)
    const tick = (now: number): void => {
      // A capped step means a stall the pill's CSS clock ran through; publishing resyncs the pill.
      const stalled = now - last > MAX_STEP_MS
      elapsedRef.current += Math.min(now - last, MAX_STEP_MS) / 1000
      last = now
      const at = elapsedRef.current
      if (at >= total) {
        goTo(page + 1)
        return
      }
      const continuous = botsTipFrameIsContinuous(page, at)
      if (at >= nextCue || stalled || (continuous && now - lastPaint >= FRAME_MS)) {
        lastPaint = now
        nextCue = nextBotsTipCue(page, at)
        setElapsed(at)
      }
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
    // `visit` restarts the clock when a page is chosen again, even the current one.
  }, [playing, page, visit, goTo])

  const end = endOf(page)
  const t = reducedMotion ? end : Math.min(elapsed, end)
  return {
    page,
    t,
    pageTimes: BOTS_TIP_PAGE_END.map((pageEnd, index) =>
      reducedMotion ? pageEnd : index === page ? t : (left[index] ?? 0)
    ),
    pageSeconds: end + BOTS_TIP_PAGE_HOLD,
    pageElapsed: reducedMotion
      ? end + BOTS_TIP_PAGE_HOLD
      : Math.min(elapsed, end + BOTS_TIP_PAGE_HOLD),
    playing,
    visit,
    pageStarts: starts,
    reducedMotion,
    goTo
  }
}
