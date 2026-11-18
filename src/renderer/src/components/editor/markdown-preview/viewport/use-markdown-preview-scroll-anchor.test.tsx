// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/lib/list-interaction/virtualized-scrolling/useVirtualizedScrollAnchor'
import { parseMarkdownPreviewDocument } from '../document-worker/markdown-preview-document-tree'
import type { MarkdownPreviewBlock } from '../document-worker/markdown-preview-document-types'
import { useMarkdownPreviewScrollAnchor } from './use-markdown-preview-scroll-anchor'

function createScrollContainer(): HTMLDivElement {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 600 }
  })
  document.body.append(element)
  return element
}

function useScrollAnchorHarness({
  blocks,
  scrollCacheKey,
  revision,
  element
}: {
  blocks: MarkdownPreviewBlock[]
  scrollCacheKey: string
  revision: number
  element: HTMLDivElement
}): void {
  const rootRef = useRef<HTMLDivElement | null>(element)
  rootRef.current = element
  const [scrollMarks] = useState(createProgrammaticScrollMarks)
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: blocks.length,
    getScrollElement: () => rootRef.current,
    estimateSize: () => 100,
    initialRect: { width: 800, height: 600 },
    observeElementRect: (_instance, onRect) => {
      onRect({ width: 800, height: 600 })
      return () => {}
    },
    scrollToFn: (offset) => {
      scrollMarks.mark(offset)
      element.scrollTop = offset
    }
  })

  useMarkdownPreviewScrollAnchor({
    blocks,
    rootRef,
    virtualizer,
    scrollCacheKey,
    revision,
    scrollMarks,
    viewportReady: true
  })
}

let testKeyCounter = 0

function nextScrollCacheKey(): string {
  testKeyCounter += 1
  return `markdown-preview-scroll-anchor-test:${testKeyCounter}`
}

describe('markdown preview scroll anchor', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it.each([
    [
      'lines are inserted above it',
      'S.\n\n## A\n\nRead.\n',
      'S.\n\nNew.\n\n## A\n\nRead.\n',
      212,
      312
    ],
    [
      'blocks change on both sides of it',
      'A.\n\nRead.\n\nT.\n',
      'A.\n\nNew.\n\nRead.\n\nT changed.\n',
      112,
      212
    ],
    [
      'duplicate text exists in the matched suffix when lines are inserted above',
      'A.\n\nB.\n\nB.\n\nT.\n',
      'X.\n\nA.\n\nB.\n\nB.\n\nT.\n',
      212,
      312
    ],
    [
      'an identical plain paragraph is inserted above a heading',
      'A.\n\n## Read\n\nT.\n',
      'A.\n\nRead\n\n## Read\n\nT.\n',
      112,
      212
    ],
    [
      'a block is formatted inline while an identical unformatted copy is inserted below',
      'A.\n\nRead this.\n\nT.\n',
      'A.\n\nRead **this.**\n\nRead this.\n\nT.\n',
      112,
      112
    ],
    [
      // `costarring` and `liquid` share a 32-bit FNV-1a hash.
      'a block with a colliding hash is inserted above it',
      'A.\n\n\n\ncostarring\n\n\n\nT.\n',
      'A.\n\nliquid\n\n\n\ncostarring\n\nT.\n',
      112,
      212
    ],
    [
      'an empty-alt image is inserted above an empty-alt image',
      '![](kept.png)\n',
      '![](inserted.png)\n\n![](kept.png)\n',
      4,
      104
    ]
  ])(
    'keeps scrollTop anchored on the reading block when %s',
    (_, before, after, initialScrollTop, expectedScrollTop) => {
      const element = createScrollContainer()
      const scrollCacheKey = nextScrollCacheKey()
      const initialBlocks = parseMarkdownPreviewDocument(before).document.blocks
      const nextBlocks = parseMarkdownPreviewDocument(after).document.blocks

      const { rerender } = renderHook(
        ({ blocks, revision }: { blocks: MarkdownPreviewBlock[]; revision: number }) =>
          useScrollAnchorHarness({ blocks, scrollCacheKey, revision, element }),
        {
          initialProps: { blocks: initialBlocks, revision: 1 }
        }
      )

      act(() => {
        element.scrollTop = initialScrollTop
        element.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
      })

      rerender({ blocks: nextBlocks, revision: 2 })
      expect(element.scrollTop).toBe(expectedScrollTop)
    }
  )

  it('follows the anchored block across unmount and remount after an edit above it', () => {
    const firstElement = createScrollContainer()
    const scrollCacheKey = nextScrollCacheKey()
    const initialBlocks = parseMarkdownPreviewDocument('S.\n\n## A\n\nRead.\n').document.blocks
    const nextBlocks = parseMarkdownPreviewDocument('S.\n\nNew.\n\n## A\n\nRead.\n').document.blocks

    const firstView = renderHook(() =>
      useScrollAnchorHarness({
        blocks: initialBlocks,
        scrollCacheKey,
        revision: 1,
        element: firstElement
      })
    )

    act(() => {
      firstElement.scrollTop = 212
    })
    firstView.unmount()

    const remountedElement = createScrollContainer()
    renderHook(() =>
      useScrollAnchorHarness({
        blocks: nextBlocks,
        scrollCacheKey,
        revision: 2,
        element: remountedElement
      })
    )

    expect(remountedElement.scrollTop).toBe(312)
  })
})
