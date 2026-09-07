import { useLayoutEffect } from 'react'
import type React from 'react'
import { elementScroll, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { DiffSection } from '../../diff-section-types'
import { getDiffSectionRowEstimatedHeight } from '../../diff-section-layout'

const COMBINED_DIFF_OVERSCAN = 5

export function useCombinedDiffVirtualizer({
  generation,
  programmaticScrollMarks,
  renderedIndicesRef,
  rowKeys,
  scrollContainerRef,
  scrollOffsetRef,
  sectionHeights,
  sections,
  sideBySide
}: {
  generation: number
  programmaticScrollMarks: ProgrammaticScrollMarks
  renderedIndicesRef: React.RefObject<Set<number>>
  rowKeys: readonly string[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.RefObject<number>
  sectionHeights: Record<number, number>
  sections: DiffSection[]
  sideBySide: boolean
}): Virtualizer<HTMLDivElement, Element> {
  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const section = sections[index]
      if (!section) {
        return 88
      }

      return getDiffSectionRowEstimatedHeight(section, sectionHeights[index])
    },
    overscan: COMBINED_DIFF_OVERSCAN,
    initialOffset: () => scrollOffsetRef.current,
    // Why: mark every virtualizer-issued scroll so events are attributed to the user only when this code didn't cause them.
    scrollToFn: (offset, options, instance) => {
      const target = offset + (options.adjustments ?? 0)
      // Why: writing the current position emits no scroll event; a mark here would go stale and claim a later user scroll.
      if (instance.scrollElement?.scrollTop !== target) {
        programmaticScrollMarks.mark(target)
      }
      elementScroll(offset, options, instance)
    },
    // Why: TanStack re-runs getItemKey for every index on each measurement pass, so the key is
    // pre-built once per section change instead of a template string per index per pass.
    getItemKey: (index) => rowKeys[index] ?? `${index}:${generation}`
  })

  // Why: keep render pure (React Doctor); retrySection still needs the on-screen set without the virtualizer as a dep.
  const virtualItems = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    renderedIndicesRef.current = new Set(virtualItems.map((item) => item.index))
  }, [renderedIndicesRef, virtualItems])

  useLayoutEffect(() => {
    // Why: inline vs side-by-side changes Monaco row heights; re-measure on the mode flip, not on every section load.
    virtualizer.measure()
  }, [sideBySide, virtualizer])

  return virtualizer
}
