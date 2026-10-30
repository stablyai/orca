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
    if (!container || targetScrollTop === null) {
      return
    }

    let frameId = 0
    let attempts = 0
    const restoreScrollPosition = (): void => {
      const liveContainer = args.scrollContainerRef.current
      const liveTarget = args.pendingRestoreScrollTopRef.current
      if (!liveContainer || liveTarget === null) {
        return
      }

      const maxScrollTop = Math.max(0, liveContainer.scrollHeight - liveContainer.clientHeight)
      const nextScrollTop = Math.min(liveTarget, maxScrollTop)
      liveContainer.scrollTop = nextScrollTop

      // Why: only cache once the restore lands; an intermediate clamp would overwrite the real target.
      if (Math.abs(liveContainer.scrollTop - liveTarget) <= 1 || maxScrollTop >= liveTarget) {
        setWithLRU(prFilesDiffScrollTopCache, args.viewStateKey, nextScrollTop)
        args.pendingRestoreScrollTopRef.current = null
        return
      }

      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(restoreScrollPosition)
        return
      }
      // Why: cache what we actually reached; an unreachable target would replay this fight every visit.
      setWithLRU(prFilesDiffScrollTopCache, args.viewStateKey, liveContainer.scrollTop)
      args.pendingRestoreScrollTopRef.current = null
    }

    restoreScrollPosition()
    return () => window.cancelAnimationFrame(frameId)
  }, [
    args.pendingRestoreScrollTopRef,
    args.scrollContainerRef,
    args.sectionHeights,
    args.sections,
    args.viewStateKey
  ])
}
