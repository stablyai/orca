import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/lib/list-interaction/virtualized-scrolling/useVirtualizedScrollAnchor'
import type { ProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'
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

function longestIncreasingAnchorPairs(
  pairs: readonly (readonly [number, number])[]
): (readonly [number, number])[] {
  if (pairs.length === 0) {
    return []
  }
  const tailPairIndexes: number[] = []
  const predecessor = Array.from({ length: pairs.length }, () => -1)
  for (let i = 0; i < pairs.length; i += 1) {
    const nextIndex = pairs[i][1]
    let low = 0
    let high = tailPairIndexes.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (pairs[tailPairIndexes[mid]][1] < nextIndex) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    if (low > 0) {
      predecessor[i] = tailPairIndexes[low - 1]
    }
    tailPairIndexes[low] = i
  }
  const result: (readonly [number, number])[] = []
  let cursor = tailPairIndexes.at(-1) ?? -1
  while (cursor !== -1) {
    result.push(pairs[cursor])
    cursor = predecessor[cursor]
  }
  result.reverse()
  return result
}

/** Re-point an anchor at its block after a re-parse when its source position moved; source lines shift on edits above. */
function followMarkdownPreviewAnchor(
  anchor: NonNullable<VirtualizedScrollAnchor>,
  previous: readonly MarkdownPreviewBlock[],
  next: readonly MarkdownPreviewBlock[]
): NonNullable<VirtualizedScrollAnchor> {
  const mappedNextIndex = Array.from<number | null>({ length: previous.length }).fill(null)
  // Align bijective 1-to-1 anchors first (Patience LIS) so duplicated runs only align cleanly between verified borders.
  const queue: [number, number, number, number, number][] = [
    [0, previous.length, 0, next.length, 0]
  ]
  for (;;) {
    const range = queue.pop()
    if (!range) {
      break
    }
    const [pStart, pEnd, nStart, nEnd, depth] = range
    if (pStart >= pEnd || nStart >= nEnd) {
      continue
    }
    let anchors: (readonly [number, number])[] = []
    if (depth < 8) {
      const prevSeen = new Map<string, number | null>()
      for (let i = pStart; i < pEnd; i += 1) {
        const signature = previous[i].contentSignature
        prevSeen.set(signature, prevSeen.has(signature) ? null : i)
      }
      const nextSeen = new Map<string, number | null>()
      for (let j = nStart; j < nEnd; j += 1) {
        const signature = next[j].contentSignature
        nextSeen.set(signature, nextSeen.has(signature) ? null : j)
      }
      const uniquePairs: (readonly [number, number])[] = []
      for (let i = pStart; i < pEnd; i += 1) {
        const signature = previous[i].contentSignature
        if (prevSeen.get(signature) === i) {
          const matchedNextIndex = nextSeen.get(signature) ?? null
          if (matchedNextIndex !== null) {
            uniquePairs.push([i, matchedNextIndex])
          }
        }
      }
      anchors = longestIncreasingAnchorPairs(uniquePairs)
    }
    if (anchors.length > 0) {
      let prevCursor = pStart
      let nextCursor = nStart
      for (const [prevAnchor, nextAnchor] of anchors) {
        mappedNextIndex[prevAnchor] = nextAnchor
        queue.push([prevCursor, prevAnchor, nextCursor, nextAnchor, depth + 1])
        prevCursor = prevAnchor + 1
        nextCursor = nextAnchor + 1
      }
      queue.push([prevCursor, pEnd, nextCursor, nEnd, depth + 1])
      continue
    }
    let prefix = 0
    while (
      pStart + prefix < pEnd &&
      nStart + prefix < nEnd &&
      previous[pStart + prefix].contentSignature === next[nStart + prefix].contentSignature
    ) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < pEnd - pStart - prefix &&
      suffix < nEnd - nStart - prefix &&
      previous[pEnd - 1 - suffix].contentSignature === next[nEnd - 1 - suffix].contentSignature
    ) {
      suffix += 1
    }
    const ambiguousMiddleSignatures = new Set<string>()
    for (let i = pStart + prefix; i < pEnd - suffix; i += 1) {
      ambiguousMiddleSignatures.add(previous[i].contentSignature)
    }
    for (let j = nStart + prefix; j < nEnd - suffix; j += 1) {
      ambiguousMiddleSignatures.add(next[j].contentSignature)
    }
    for (let k = 0; k < prefix; k += 1) {
      if (!ambiguousMiddleSignatures.has(previous[pStart + k].contentSignature)) {
        mappedNextIndex[pStart + k] = nStart + k
      }
    }
    for (let k = 0; k < suffix; k += 1) {
      if (!ambiguousMiddleSignatures.has(previous[pEnd - 1 - k].contentSignature)) {
        mappedNextIndex[pEnd - 1 - k] = nEnd - 1 - k
      }
    }
  }
  const previousIndexByKey = new Map(
    previous.map((block, index) => [markdownPreviewScrollAnchorKey(block), index])
  )
  // Keep the original key when no unambiguous match exists; ambiguous duplicates fall back safely.
  const follow = (key: string): string => {
    const index = previousIndexByKey.get(key)
    if (index === undefined) {
      return key
    }
    const nextIndex = mappedNextIndex[index]
    return nextIndex === null ? key : markdownPreviewScrollAnchorKey(next[nextIndex])
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
