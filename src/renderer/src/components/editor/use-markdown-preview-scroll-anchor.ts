import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import type { MarkdownPreviewBlock } from './markdown-preview-document-types'

const anchors = new Map<string, VirtualizedScrollAnchor>()
export const markdownPreviewScrollAnchorKey = (block: MarkdownPreviewBlock): string =>
  block.sourceLine !== null && block.sourceColumn !== undefined
    ? `source:${block.sourceLine}:${block.sourceColumn}`
    : `index:${block.index}`
const elementKey = (element: HTMLDivElement): string | null =>
  element.getAttribute('data-preview-block-key')

export function useMarkdownPreviewScrollAnchor({
  blocks,
  rootRef,
  virtualizer,
  scrollCacheKey,
  revision,
  scrollMarks,
  viewportReady
}: {
  blocks: MarkdownPreviewBlock[]
  rootRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  scrollCacheKey: string
  revision: number
  scrollMarks: ProgrammaticScrollMarks
  viewportReady: boolean
}): void {
  const [initialPosition] = useState(() => ({
    anchor: anchors.get(scrollCacheKey) ?? null,
    offset: scrollTopCache.get(scrollCacheKey) ?? 0
  }))
  const anchorRef = useRef(initialPosition.anchor)
  const offsetRef = useRef(initialPosition.offset)
  const shouldSkipRestore = useCallback(() => !viewportReady, [viewportReady])
  useVirtualizedScrollAnchor({
    anchorRef,
    scrollOffsetRef: offsetRef,
    rows: blocks,
    getRowKey: markdownPreviewScrollAnchorKey,
    getItemElementKey: elementKey,
    itemElementSelector: '[data-preview-block-index][data-preview-block-loaded]',
    scrollElementRef: rootRef,
    virtualizer,
    totalSize: virtualizer.getTotalSize(),
    programmaticScrollMarks: scrollMarks,
    shouldSkipRestore,
    restoreSignal: `${scrollCacheKey}:${revision}`
  })
  useLayoutEffect(
    () => () => {
      setWithLRU(anchors, scrollCacheKey, anchorRef.current)
    },
    [scrollCacheKey]
  )
}
