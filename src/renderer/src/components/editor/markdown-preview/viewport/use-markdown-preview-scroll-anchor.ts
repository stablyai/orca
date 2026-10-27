import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import {
  scrollTopCache,
  setWithLRU
} from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import type { MarkdownPreviewBlock } from '../document-worker/markdown-preview-document-types'

// Keep the blocks an anchor was recorded against so a remount can still follow it.
const anchors = new Map<
  string,
  { anchor: VirtualizedScrollAnchor; blocks: readonly MarkdownPreviewBlock[] }
>()
export const markdownPreviewScrollAnchorKey = (block: MarkdownPreviewBlock): string =>
  block.sourceLine !== null && block.sourceColumn !== undefined
    ? `source:${block.sourceLine}:${block.sourceColumn}`
    : `index:${block.index}`

/** Re-point an anchor at its block when only blocks before or after it changed; source lines shift on edits above. */
export function followMarkdownPreviewAnchor(
  anchor: NonNullable<VirtualizedScrollAnchor>,
  previous: readonly MarkdownPreviewBlock[],
  next: readonly MarkdownPreviewBlock[]
): NonNullable<VirtualizedScrollAnchor> {
  const same = (previousIndex: number, nextIndex: number): boolean =>
    previous[previousIndex].contentSignature === next[nextIndex].contentSignature
  let start = 0
  while (start < previous.length && start < next.length && same(start, start)) {
    start += 1
  }
  let end = 0
  while (
    end < previous.length - start &&
    end < next.length - start &&
    same(previous.length - 1 - end, next.length - 1 - end)
  ) {
    end += 1
  }
  const previousIndexByKey = new Map(
    previous.map((block, index) => [markdownPreviewScrollAnchorKey(block), index])
  )
  const nextSignatureByKey = new Map(
    next.map((block) => [markdownPreviewScrollAnchorKey(block), block.contentSignature])
  )
  // Keep the key inside the edited span, or while it still names the same text; identical text can't be told apart.
  const follow = (key: string): string => {
    const index = previousIndexByKey.get(key)
    if (
      index === undefined ||
      (index >= start && index < previous.length - end) ||
      nextSignatureByKey.get(key) === previous[index].contentSignature
    ) {
      return key
    }
    const nextIndex = index < start ? index : index + next.length - previous.length
    return markdownPreviewScrollAnchorKey(next[nextIndex])
  }
  return { ...anchor, key: follow(anchor.key), fallbackKeys: anchor.fallbackKeys?.map(follow) }
}
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
    anchor: anchors.get(scrollCacheKey)?.anchor ?? null,
    blocks: anchors.get(scrollCacheKey)?.blocks ?? blocks,
    offset: scrollTopCache.get(scrollCacheKey) ?? 0
  }))
  const anchorRef = useRef(initialPosition.anchor)
  const offsetRef = useRef(initialPosition.offset)
  const blocksRef = useRef(initialPosition.blocks)
  const shouldSkipRestore = useCallback(() => !viewportReady, [viewportReady])
  // Declared before the restore below, so a re-parse restores the followed key.
  useLayoutEffect(() => {
    const previous = blocksRef.current
    blocksRef.current = blocks
    if (previous !== blocks && anchorRef.current) {
      anchorRef.current = followMarkdownPreviewAnchor(anchorRef.current, previous, blocks)
    }
  }, [blocks])
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
      setWithLRU(anchors, scrollCacheKey, { anchor: anchorRef.current, blocks: blocksRef.current })
    },
    [scrollCacheKey]
  )
}
