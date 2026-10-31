import { getCombinedDiffExtent } from '@/components/editor/combined-diff-extent-dom'
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
  viewportNode: HTMLDivElement | null
  beforeDetachRef: RefObject<(() => void) | null>
  releaseViewport: () => void
  pendingRestoreScrollTopRef: MutableRefObject<number | null>
}): void {
  useEffect(() => {
    if (args.sections.length === 0 && args.entriesLength > 0) {
      return
    }
    const preservedScrollTop =
      prFilesDiffScrollTopCache.get(args.viewStateKey) ??
      (args.viewportNode ? getCombinedDiffExtent(args.viewportNode).exportView().scrollTop : 0)
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
    args.viewportNode,
    args.sectionHeights,
    args.sections,
    args.sideBySide,
    args.viewStateKey
  ])

  useLayoutEffect(() => {
    const container = args.viewportNode
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
      writeCachedScrollPosition(getCombinedDiffExtent(container).exportView().scrollTop)
    }

    const cacheScrollPositionOnTeardown = (): void => {
      // Why: tearing down mid-restore must persist the pending target, not the clamped intermediate.
      writeCachedScrollPosition(
        args.pendingRestoreScrollTopRef.current ??
          getCombinedDiffExtent(container).exportView().scrollTop
      )
    }

    container.addEventListener('scroll', cacheScrollPositionOnScroll, { passive: true })
    args.beforeDetachRef.current = () => {
      cacheScrollPositionOnTeardown()
      container.removeEventListener('scroll', cacheScrollPositionOnScroll)
    }
    return args.releaseViewport
  }, [
    args.beforeDetachRef,
    args.releaseViewport,
    args.entrySignature,
    args.pendingRestoreScrollTopRef,
    args.viewportNode,
    args.viewStateKey
  ])

  useLayoutEffect(() => {
    const container = args.viewportNode
    const targetScrollTop =
      args.pendingRestoreScrollTopRef.current ??
      prFilesDiffScrollTopCache.get(args.viewStateKey) ??
      0
    if (!container) {
      return
    }

    getCombinedDiffExtent(container).importView({ scrollTop: targetScrollTop })
    setWithLRU(prFilesDiffScrollTopCache, args.viewStateKey, targetScrollTop)
    args.pendingRestoreScrollTopRef.current = null
  }, [args.pendingRestoreScrollTopRef, args.viewportNode, args.viewStateKey])
}
