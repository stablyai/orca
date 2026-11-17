import { useCallback, useEffect, useRef } from 'react'
import type { PostRenderPhase } from '@pierre/diffs'
import {
  clearPierreUnicodeHighlights,
  paintPierreUnicodeHighlights
} from './pierre-diff-unicode-highlight'

/** Flags invisible and ASCII-confusable characters, as Monaco's diff did for trojan-source review. */
export function usePierreDiffUnicodeHighlight(language: string | undefined) {
  const owner = useRef(Symbol())
  const frame = useRef<number | null>(null)
  // Same rule as main: Markdown prose legitimately mixes scripts.
  const includeAmbiguous = language !== 'markdown'
  useEffect(() => {
    const token = owner.current
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
      clearPierreUnicodeHighlights(token)
    }
  }, [])
  return useCallback(
    (host: HTMLElement, phase: PostRenderPhase) => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
      if (phase === 'unmount') {
        clearPierreUnicodeHighlights(owner.current)
        return
      }
      // Coalesce a burst of renders (scrolling, typing) into one scan of the mounted rows.
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        paintPierreUnicodeHighlights(owner.current, host, includeAmbiguous)
      })
    },
    [includeAmbiguous]
  )
}
