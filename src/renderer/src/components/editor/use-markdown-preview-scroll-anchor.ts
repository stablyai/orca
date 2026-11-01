import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import type { MarkdownPreviewBlock } from './markdown-preview-document-types'

// Keep the blocks an anchor was recorded against so a remount can still follow it.
const anchors = new Map<
  string,
  { anchor: VirtualizedScrollAnchor; blocks: readonly MarkdownPreviewBlock[] }
>()
export const markdownPreviewScrollAnchorKey = (block: MarkdownPreviewBlock): string =>
  block.sourceLine !== null && block.sourceColumn !== undefined
    ? `source:${block.sourceLine}:${block.sourceColumn}`
    : `index:${block.index}`

/** Re-point an anchor at its block after a re-parse when its source position moved; source lines shift on edits above. */
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
  // Inside the edited span a block follows only when its text occurs once on each side.
  const previousSpanCounts = new Map<string, number>()
  for (let index = start; index < previous.length - end; index += 1) {
    const signature = previous[index].contentSignature
    previousSpanCounts.set(signature, (previousSpanCounts.get(signature) ?? 0) + 1)
  }
  const nextSpanIndexes = new Map<string, number | null>()
  for (let index = start; index < next.length - end; index += 1) {
    const signature = next[index].contentSignature
    nextSpanIndexes.set(signature, nextSpanIndexes.has(signature) ? null : index)
  }
  const nextIndexOf = (index: number): number | null => {
    if (index < start) {
      return index
    }
    if (index >= previous.length - end) {
      return index + next.length - previous.length
    }
    const signature = previous[index].contentSignature
    return previousSpanCounts.get(signature) === 1 ? (nextSpanIndexes.get(signature) ?? null) : null
  }
  // Keep the key when the block can't be followed, or while it still names the same text; identical text can't be told apart.
  const follow = (key: string): string => {
    const index = previousIndexByKey.get(key)
    const nextIndex = index === undefined ? null : nextIndexOf(index)
    if (
      index === undefined ||
      nextIndex === null ||
      nextSignatureByKey.get(key) === previous[index].contentSignature
    ) {
      return key
    }
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
