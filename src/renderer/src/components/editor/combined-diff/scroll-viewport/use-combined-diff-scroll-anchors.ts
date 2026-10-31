import {
  getCombinedDiffExtent,
  scrollCombinedDiffToIndex,
  publishCombinedDiffMeasurements
} from '../../combined-diff-extent-dom'
import { useCallback, useMemo, useLayoutEffect, useRef } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { getVirtualizedScrollAnchorForOffset } from '@/hooks/virtualized-scroll-anchor-recording'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { DiffSection } from '../../diff-section-types'
import {
  rememberCombinedDiffView,
  type CombinedDiffViewLease
} from '../remember-view/combined-diff-view-cache'

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
  scrollAnchorRef,
  scrollContainerRef,
  scrollOffsetRef,
  sectionIndexByKey,
  sectionsRef,
  sideBySide,
  structureRevision,
  memoryLeaseRef,
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
  memoryLeaseRef: React.RefObject<CombinedDiffViewLease | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): CombinedDiffScrollAnchors {
  const getCombinedDiffSectionKey = useCallback((section: DiffSection): string => section.key, [])
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
    rememberCombinedDiffView(memoryLeaseRef.current, {
      scrollAnchor: scrollAnchorRef.current ?? undefined
    })
  }, [memoryLeaseRef, scrollAnchorRef])
  const persistScrollAnchor = useCallback(
    (refreshDomAnchor = true): void => {
      if (refreshDomAnchor) {
        recordDomScrollAnchor()
      }
      writeScrollAnchor()
    },
    [recordDomScrollAnchor, writeScrollAnchor]
  )

  // Restore on structural changes only; measurement churn must not overwrite active wheel scrolling.
  const combinedDiffRestoreSignal = useMemo(
    () =>
      // Reload generations invalidate row heights; structureRevision captures those and collapse/key changes without full key joins.
      `${generation}|${sideBySide ? 'sbs' : 'inline'}|${clampRestoreCount}|${structureRevision}`,
    [clampRestoreCount, generation, sideBySide, structureRevision]
  )

  const previousSignal = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container || previousSignal.current === combinedDiffRestoreSignal) {
      return
    }
    previousSignal.current = combinedDiffRestoreSignal
    if (hasDirectScrollInput()) {
      return
    }
    publishCombinedDiffMeasurements(virtualizer)
    const anchor = scrollAnchorRef.current
    const key =
      anchor &&
      (sectionIndexByKey.has(anchor.key)
        ? anchor.key
        : anchor.fallbackKeys?.find((candidate) => sectionIndexByKey.has(candidate)))
    const index = key ? sectionIndexByKey.get(key) : undefined
    if (index !== undefined) {
      scrollCombinedDiffToIndex(
        virtualizer,
        index,
        anchor && key === anchor.key ? anchor.offset : 0
      )
    } else {
      getCombinedDiffExtent(container).navigate(scrollOffsetRef.current)
    }
  }, [
    combinedDiffRestoreSignal,
    hasDirectScrollInput,
    scrollAnchorRef,
    scrollContainerRef,
    scrollOffsetRef,
    sectionIndexByKey,
    virtualizer
  ])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const record = (): void => {
      recordDomScrollAnchor()
    }
    container?.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, record)
    return () => container?.removeEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, record)
  }, [recordDomScrollAnchor, scrollContainerRef])

  const scrollToSectionIndex = useCallback(
    (index: number): void => {
      scrollAnchorRef.current = null
      latestDomScrollAnchorRef.current = null
      scrollCombinedDiffToIndex(virtualizer, index)
      // Programmatic jumps emit no anchor-recording scroll; snapshot the destination after layout settles.
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
