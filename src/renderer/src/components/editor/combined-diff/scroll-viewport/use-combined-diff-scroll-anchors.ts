import { useCallback, useMemo } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  useVirtualizedScrollAnchor,
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { getVirtualizedScrollAnchorForOffset } from '@/hooks/virtualized-scroll-anchor-recording'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { setWithLRU } from '@/lib/scroll-cache'
import type { DiffSection } from '../../diff-section-types'
import { combinedDiffScrollAnchorCache } from '../remember-view/combined-diff-view-memory'

export type CombinedDiffScrollAnchors = {
  persistScrollAnchor: (refreshDomAnchor?: boolean) => void
  scrollToSectionIndex: (index: number) => void
  recordDomScrollAnchor: () => boolean
  recordVirtualScrollAnchor: (scrollTop: number) => void
  writeScrollAnchor: () => void
}

export function useCombinedDiffScrollAnchors({
  clampRestoreCount,
  generation,
  hasDirectScrollInput,
  latestDomScrollAnchorRef,
  programmaticScrollMarks,
  scrollAnchorRef,
  scrollContainerRef,
  scrollOffsetRef,
  sectionIndexByKey,
  sections,
  sectionsRef,
  sideBySide,
  structureRevision,
  totalSize,
  viewStateKey,
  virtualizer
}: {
  clampRestoreCount: number
  generation: number
  hasDirectScrollInput: () => boolean
  latestDomScrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
  programmaticScrollMarks: ProgrammaticScrollMarks
  scrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.RefObject<number>
  sectionIndexByKey: ReadonlyMap<string, number>
  sections: DiffSection[]
  sectionsRef: React.RefObject<DiffSection[]>
  sideBySide: boolean
  structureRevision: number
  totalSize: number
  viewStateKey: string
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): CombinedDiffScrollAnchors {
  const getCombinedDiffSectionKey = useCallback((section: DiffSection): string => section.key, [])
  const getCombinedDiffSectionElementKey = useCallback(
    (element: Element): string | null =>
      element instanceof HTMLElement ? (element.dataset.combinedDiffSectionKey ?? null) : null,
    []
  )
  const recordVirtualScrollAnchor = useCallback(
    (scrollTop: number): void => {
      scrollAnchorRef.current = getVirtualizedScrollAnchorForOffset({
        getRowKey: getCombinedDiffSectionKey,
        rows: sectionsRef.current,
        scrollTop,
        virtualItems: virtualizer.getVirtualItems()
      })
      latestDomScrollAnchorRef.current = null
    },
    [getCombinedDiffSectionKey, latestDomScrollAnchorRef, scrollAnchorRef, sectionsRef, virtualizer]
  )
  const recordDomScrollAnchor = useCallback((): boolean => {
    const container = scrollContainerRef.current
    if (!container) {
      return false
    }

    const containerRect = container.getBoundingClientRect()
    const visibleRows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-combined-diff-section-row]')
    )
      .map((row) => {
        const key = row.dataset.combinedDiffSectionKey
        if (!key || !row.isConnected) {
          return null
        }
        const rect = row.getBoundingClientRect()
        if (
          rect.height <= 0 ||
          rect.bottom <= containerRect.top ||
          rect.top >= containerRect.bottom
        ) {
          return null
        }
        return { key, rect }
      })
      .filter((row): row is { key: string; rect: DOMRect } => row !== null)
      .sort((a, b) => a.rect.top - b.rect.top)

    const firstVisible = visibleRows[0]
    if (!firstVisible) {
      return false
    }

    const anchor: NonNullable<VirtualizedScrollAnchor> = {
      fallbackKeys: visibleRows.slice(1).map((row) => row.key),
      key: firstVisible.key,
      offset: Math.min(
        firstVisible.rect.height,
        Math.max(0, containerRect.top - firstVisible.rect.top)
      ),
      scrollTop: container.scrollTop
    }
    scrollAnchorRef.current = anchor
    latestDomScrollAnchorRef.current = anchor
    return true
  }, [latestDomScrollAnchorRef, scrollAnchorRef, scrollContainerRef])
  const writeScrollAnchor = useCallback((): void => {
    const anchor = scrollAnchorRef.current
    if (anchor) {
      setWithLRU(combinedDiffScrollAnchorCache, viewStateKey, anchor)
    } else {
      combinedDiffScrollAnchorCache.delete(viewStateKey)
    }
  }, [scrollAnchorRef, viewStateKey])
  const persistScrollAnchor = useCallback(
    (refreshDomAnchor = true): void => {
      if (refreshDomAnchor) {
        recordDomScrollAnchor()
      }
      writeScrollAnchor()
    },
    [recordDomScrollAnchor, writeScrollAnchor]
  )

  // Why: restore only on structural changes — restoring on measurement churn overwrote scrollTop during active wheel input.
  const combinedDiffRestoreSignal = useMemo(
    () =>
      // Why: a single-section reload drops that row's measured height, so it shifts rows
      // below it — still a structural change even though `generation` no longer moves.
      // structureRevision moves iff a section key/collapsed/contentGeneration moved, so this is
      // the same signal the per-section join produced without rebuilding it once per load.
      `${generation}|${sideBySide ? 'sbs' : 'inline'}|${clampRestoreCount}|${structureRevision}`,
    [clampRestoreCount, generation, sideBySide, structureRevision]
  )

  useVirtualizedScrollAnchor({
    anchorRef: scrollAnchorRef,
    getItemElementKey: getCombinedDiffSectionElementKey,
    getRowKey: getCombinedDiffSectionKey,
    hasDirectScrollInput,
    itemElementSelector: '[data-combined-diff-section-row]',
    programmaticScrollMarks,
    recordAnchorOnCleanup: false,
    recordAnchorOnScroll: false,
    restoreSignal: combinedDiffRestoreSignal,
    rowIndexByKey: sectionIndexByKey,
    rows: sections,
    scrollElementRef: scrollContainerRef,
    shouldSkipRestore: hasDirectScrollInput,
    scrollOffsetRef,
    totalSize,
    virtualizer
  })

  const scrollToSectionIndex = useCallback(
    (index: number): void => {
      scrollAnchorRef.current = null
      latestDomScrollAnchorRef.current = null
      virtualizer.scrollToIndex(index, { align: 'start' })
      // Why: this jump is programmatic (no scroll event records an anchor); snapshot the destination once layout settles.
      window.requestAnimationFrame(() => {
        scrollContainerRef.current?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
      })
    },
    [latestDomScrollAnchorRef, scrollAnchorRef, scrollContainerRef, virtualizer]
  )

  return {
    persistScrollAnchor,
    recordDomScrollAnchor,
    recordVirtualScrollAnchor,
    scrollToSectionIndex,
    writeScrollAnchor
  }
}
