import { scrollCombinedDiffTo } from '@/components/editor/combined-diff-extent-dom'
import { useEffect, useLayoutEffect, type MutableRefObject, type RefObject } from 'react'
import { setWithLRU } from '@/lib/scroll-cache'
import type { DiffSection } from '@/components/editor/diff-section-types'
import { prFilesDiffScrollTopCache, prFilesDiffViewStateCache } from '../cache/files-diff-view'

export function usePRFilesDiffViewPersistence(args: {
  sections: DiffSection[]
  entriesLength: number
  viewStateKey: string
  entrySignature: string
  sectionHeights: Record<number, number>
  sideBySide: boolean
  fileTreeCollapsed: boolean
  activeTreeSectionKey: string | null
  loadedIndicesRef: MutableRefObject<Set<number>>
  scrollContainerRef: RefObject<HTMLDivElement | null>
  pendingRestoreScrollTopRef: MutableRefObject<number | null>
}): void {
  useEffect(() => {
    if (args.sections.length === 0 && args.entriesLength > 0) {
      return
    }
    const preservedScrollTop =
      prFilesDiffScrollTopCache.get(args.viewStateKey) ??
      args.scrollContainerRef.current?.scrollTop ??
      0
    setWithLRU(prFilesDiffViewStateCache, args.viewStateKey, {
      entrySignature: args.entrySignature,
      sections: args.sections,
      sectionHeights: args.sectionHeights,
      loadedIndices: Array.from(args.loadedIndicesRef.current).filter(
        (index) => !args.sections[index]?.loading
      ),
      scrollTop: preservedScrollTop,
      sideBySide: args.sideBySide,
      fileTreeCollapsed: args.fileTreeCollapsed,
      activeTreeSectionKey: args.activeTreeSectionKey
    })
  }, [
    args.activeTreeSectionKey,
    args.entriesLength,
    args.entrySignature,
    args.fileTreeCollapsed,
    args.loadedIndicesRef,
    args.scrollContainerRef,
    args.sectionHeights,
    args.sections,
    args.sideBySide,
    args.viewStateKey
  ])

  useLayoutEffect(() => {
    const container = args.scrollContainerRef.current
    if (!container) {
      return
    }

    const writeCachedScrollPosition = (scrollTop: number): void => {
      const existing = prFilesDiffViewStateCache.get(args.viewStateKey)
      setWithLRU(prFilesDiffScrollTopCache, args.viewStateKey, scrollTop)
      if (!existing || existing.entrySignature !== args.entrySignature) {
        return
      }
      setWithLRU(prFilesDiffViewStateCache, args.viewStateKey, { ...existing, scrollTop })
    }

    const cacheScrollPositionOnScroll = (): void => {
      // Why: mid-restore scrollTop is a clamped intermediate, so caching it would lose the real target.
      if (args.pendingRestoreScrollTopRef.current !== null) {
        return
      }
      writeCachedScrollPosition(container.scrollTop)
    }

    const cacheScrollPositionOnTeardown = (): void => {
      // Why: tearing down mid-restore must persist the pending target, not the clamped intermediate.
      writeCachedScrollPosition(args.pendingRestoreScrollTopRef.current ?? container.scrollTop)
    }

    container.addEventListener('scroll', cacheScrollPositionOnScroll, { passive: true })
    return () => {
      cacheScrollPositionOnTeardown()
      container.removeEventListener('scroll', cacheScrollPositionOnScroll)
    }
  }, [
    args.entrySignature,
    args.pendingRestoreScrollTopRef,
    args.scrollContainerRef,
    args.viewStateKey
  ])

  useLayoutEffect(() => {
    const container = args.scrollContainerRef.current
    const targetScrollTop = args.pendingRestoreScrollTopRef.current
    if (
      !container ||
      targetScrollTop === null ||
      (args.sections.length === 0 && args.entriesLength > 0)
    ) {
      return
    }

    scrollCombinedDiffTo(container, targetScrollTop)
    setWithLRU(prFilesDiffScrollTopCache, args.viewStateKey, container.scrollTop)
    args.pendingRestoreScrollTopRef.current = null
  }, [
    args.entriesLength,
    args.pendingRestoreScrollTopRef,
    args.scrollContainerRef,
    args.sectionHeights,
    args.sections,
    args.viewStateKey
  ])
}
