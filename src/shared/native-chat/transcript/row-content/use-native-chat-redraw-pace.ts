import type * as React from 'react'

/** A growing reply's redraws may take at most this share of the main thread. */
const REDRAW_SHARE = 0.25
/** One slow sample, such as a garbage collection, holds the newest text no longer than this. */
const MAX_HOLD_MS = 1000

/** When the next redraw may start after one that took `cost` ms and finished at `drawnAt`. */
export function nativeChatNextRedrawAt(drawnAt: number, cost: number): number {
  return drawnAt + Math.min(MAX_HOLD_MS, (cost * (1 - REDRAW_SHARE)) / REDRAW_SHARE)
}

/** Reports how long the platform spent drawing the next frame (style, layout, paint) after a
 *  commit; returns a cancel. */
export type NativeChatMeasureFrameRendering = (done: (ms: number) => void) => () => void

/** Costly redraws of a growing reply (a reply that must be parsed whole, a huge reply) come less
 *  often instead of every frame; cheap ones and the finished text draw at once. */
export function createNativeChatRedrawPaceHook(
  {
    useEffect,
    useLayoutEffect,
    useReducer,
    useRef
  }: Pick<typeof React, 'useEffect' | 'useLayoutEffect' | 'useReducer' | 'useRef'>,
  measureFrameRendering?: NativeChatMeasureFrameRendering
) {
  return function useNativeChatRedrawPace(text: string, growing: boolean): string {
    const [woken, wake] = useReducer((count: number) => count + 1, 0)
    const pace = useRef({ drawn: text, nextAt: 0, renderAt: 0 })
    const measuring = useRef<(() => void) | undefined>(undefined)
    const hold = growing && text !== pace.current.drawn && performance.now() < pace.current.nextAt
    const drawn = hold ? pace.current.drawn : text
    if (drawn !== pace.current.drawn) {
      pace.current.renderAt = performance.now()
    }

    // Runs after the subtree's own layout effects, so the cost covers its render and commit.
    useLayoutEffect(() => {
      if (drawn === pace.current.drawn) {
        return
      }
      const now = performance.now()
      const cost = now - pace.current.renderAt
      pace.current = { drawn, nextAt: nativeChatNextRedrawAt(now, cost), renderAt: 0 }
      if (measureFrameRendering && !measuring.current) {
        measuring.current = measureFrameRendering((rendering) => {
          measuring.current = undefined
          pace.current.nextAt = Math.max(
            pace.current.nextAt,
            nativeChatNextRedrawAt(now, cost + rendering)
          )
        })
      }
    }, [drawn])

    useEffect(() => () => measuring.current?.(), [])

    useEffect(() => {
      if (!hold) {
        return
      }
      const timer = setTimeout(wake, Math.max(0, pace.current.nextAt - performance.now()))
      return () => clearTimeout(timer)
    }, [hold, text, woken])

    return drawn
  }
}
