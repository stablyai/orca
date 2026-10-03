import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import type { MarkdownPreviewBlock } from './markdown-preview-document-types'

const anchors = new Map<string, VirtualizedScrollAnchor>()
const blockKey = (block: MarkdownPreviewBlock): string => String(block.index)
const elementKey = (element: HTMLDivElement): string | null =>
  element.getAttribute('data-preview-block-index')

export function useMarkdownPreviewScrollAnchor({
  blocks,
  rootRef,
  virtualizer,
  scrollCacheKey,
  revision
}: {
  blocks: MarkdownPreviewBlock[]
  rootRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  scrollCacheKey: string
  revision: number
}): void {
  const [initialPosition] = useState(() => ({
    anchor: anchors.get(scrollCacheKey) ?? null,
    offset: scrollTopCache.get(scrollCacheKey) ?? 0
  }))
  const anchorRef = useRef(initialPosition.anchor)
  const offsetRef = useRef(initialPosition.offset)
  useVirtualizedScrollAnchor({
    anchorRef,
    scrollOffsetRef: offsetRef,
    rows: blocks,
    getRowKey: blockKey,
    getItemElementKey: elementKey,
    itemElementSelector: '[data-preview-block-index][data-preview-block-loaded]',
    scrollElementRef: rootRef,
    virtualizer,
    totalSize: virtualizer.getTotalSize(),
    restoreSignal: `${scrollCacheKey}:${revision}`
  })
  useLayoutEffect(
    () => () => {
      setWithLRU(anchors, scrollCacheKey, anchorRef.current)
    },
    [scrollCacheKey]
  )
}
