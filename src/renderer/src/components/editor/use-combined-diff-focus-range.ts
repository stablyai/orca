import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'
import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual'
import { getCombinedDiffFocusOwner } from './combined-diff-overflow'

export function useCombinedDiffFocusRange(
  viewport: RefObject<HTMLDivElement | null>,
  extract: (range: Range) => number[] = defaultRangeExtractor
): (range: Range) => number[] {
  const [focused, setFocused] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const update = (): void => {
      const active = document.activeElement
      const row = active ? getCombinedDiffFocusOwner(active) : null
      setFocused(row && viewport.current?.contains(row) ? row : null)
    }
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    update()
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
    }
  }, [viewport])
  return useCallback(
    (range: Range) => {
      const indices = extract(range)
      const index =
        focused && viewport.current?.contains(focused) ? Number(focused.dataset.index) : Number.NaN
      return Number.isInteger(index) &&
        index >= 0 &&
        index < range.count &&
        !indices.includes(index)
        ? [...indices, index].sort((a, b) => a - b)
        : indices
    },
    [extract, focused, viewport]
  )
}
