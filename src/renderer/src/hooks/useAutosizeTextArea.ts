/** Auto-grow a textarea to fit its content. Height tracks the value (not just
 *  change events), so clearing or deleting text shrinks it back. An optional
 *  line cap converts growth into internal scrolling past that many lines. */
import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

export type AutosizeTextAreaOptions = {
  /** Grow up to this many rendered lines, then scroll internally. Unbounded when omitted. */
  maxLines?: number
}

/** Border-box height of `maxLines` rendered lines: computed line-height plus
 *  vertical padding. Null when line-height doesn't resolve to pixels (e.g.
 *  'normal', or test DOMs without layout), which means "don't clamp". */
export function autosizeTextAreaMaxHeightPx(
  style: Pick<CSSStyleDeclaration, 'lineHeight' | 'paddingTop' | 'paddingBottom'>,
  maxLines: number
): number | null {
  const lineHeight = Number.parseFloat(style.lineHeight)
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return null
  }
  const padding =
    (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  return Math.ceil(lineHeight * maxLines + padding)
}

/** Content height clamped to the cap; a null cap grows freely. */
export function clampAutosizeTextAreaHeight(
  scrollHeight: number,
  maxHeightPx: number | null
): number {
  return maxHeightPx === null ? scrollHeight : Math.min(scrollHeight, maxHeightPx)
}

export function useAutosizeTextArea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { maxLines }: AutosizeTextAreaOptions = {}
): void {
  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea) {
      return
    }
    // Collapse first so deletions re-measure instead of keeping the old height.
    textarea.style.height = 'auto'
    const maxHeightPx =
      maxLines === undefined
        ? null
        : autosizeTextAreaMaxHeightPx(getComputedStyle(textarea), maxLines)
    textarea.style.height = `${clampAutosizeTextAreaHeight(textarea.scrollHeight, maxHeightPx)}px`
  }, [ref, value, maxLines])
}
