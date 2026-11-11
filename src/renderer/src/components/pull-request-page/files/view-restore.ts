import { useEffect, useLayoutEffect, type MutableRefObject } from 'react'
import { setWithLRU } from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import type { DiffSection } from '@/components/editor/diff/sections/diff-section-types'
import type { DiffReadingAnchor } from '@/components/editor/combined-diff/scroll-viewport/combined-diff-layout'
import type { CombinedDiffViewportOwner } from '@/components/editor/combined-diff/scroll-viewport/combined-diff-viewport-owner'
import { prFilesDiffViewStateCache } from '../cache/files-diff-view'

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
  viewport: CombinedDiffViewportOwner
  pendingRestoreAnchorRef: MutableRefObject<{ anchor: DiffReadingAnchor | null } | null>
}): void {
  useLayoutEffect(() => {
    const pending = args.pendingRestoreAnchorRef.current
    if (pending && args.sections.length > 0) {
      args.viewport.importView(pending.anchor, 0)
      args.pendingRestoreAnchorRef.current = null
    }
  }, [args.pendingRestoreAnchorRef, args.sections, args.viewport])

  useEffect(() => {
    if (args.sections.length === 0 && args.entriesLength > 0) {
      return
    }
    const existing = prFilesDiffViewStateCache.get(args.viewStateKey)
    setWithLRU(prFilesDiffViewStateCache, args.viewStateKey, {
      entrySignature: args.entrySignature,
      sections: args.sections,
      sectionHeights: Object.fromEntries(
        args.sections.flatMap((section, index) =>
          args.sectionHeights[index] === undefined
            ? []
            : [[section.key, args.sectionHeights[index]]]
        )
      ),
      loadedIndices: Array.from(args.loadedIndicesRef.current).filter(
        (index) => !args.sections[index]?.loading
      ),
      scrollAnchor:
        existing?.entrySignature === args.entrySignature
          ? existing.scrollAnchor
          : args.viewport.getAnchor(),
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
    args.sectionHeights,
    args.sections,
    args.sideBySide,
    args.viewStateKey,
    args.viewport
  ])

  useLayoutEffect(() => {
    const persist = (): void => {
      const existing = prFilesDiffViewStateCache.get(args.viewStateKey)
      if (existing?.entrySignature !== args.entrySignature) {
        return
      }
      setWithLRU(prFilesDiffViewStateCache, args.viewStateKey, {
        ...existing,
        scrollAnchor: args.viewport.getAnchor()
      })
    }
    const unsubscribe = args.viewport.subscribeScroll(persist)
    return () => {
      persist()
      unsubscribe()
    }
  }, [args.entrySignature, args.viewStateKey, args.viewport])
}
