import { describe, expect, it } from 'vitest'
import type { VirtualItem } from '@tanstack/react-virtual'
import {
  getReconciledVirtualScrollOffset,
  reconcileVirtualizerScrollOffset
} from './scroll-offset-reconcile'
import { GROUP_HEADER_ROW_HEIGHT, getActiveStickyIndexesForScroll } from './virtual-rows'
import type { Row } from '../grouping/row-types'

const makeHeaderRow = (key: string): Extract<Row, { type: 'header' }> => ({
  type: 'header',
  key,
  label: key,
  count: 1,
  tone: 'text-foreground',
  projectGroupDepth: 0
})

describe('getReconciledVirtualScrollOffset', () => {
  it('snaps a belief the element cannot reach back to the element', () => {
    // Six collapsed project headers fit inside the viewport, so the element never scrolls.
    expect(
      getReconciledVirtualScrollOffset({
        believedOffset: 70,
        scrollTop: 0,
        scrollHeight: 198,
        clientHeight: 285,
        isScrolling: false
      })
    ).toBe(0)
  })

  it('clamps to the scrollable end when the belief overshoots a scrollable list', () => {
    expect(
      getReconciledVirtualScrollOffset({
        believedOffset: 500,
        scrollTop: 120,
        scrollHeight: 600,
        clientHeight: 400,
        isScrolling: false
      })
    ).toBe(120)
  })

  it('leaves a reachable belief alone so an in-flight scroll write can land', () => {
    expect(
      getReconciledVirtualScrollOffset({
        believedOffset: 40,
        scrollTop: 0,
        scrollHeight: 600,
        clientHeight: 400,
        isScrolling: false
      })
    ).toBeNull()
  })

  it('tolerates sub-pixel rounding at the scrollable end', () => {
    expect(
      getReconciledVirtualScrollOffset({
        believedOffset: 200.6,
        scrollTop: 200,
        scrollHeight: 600,
        clientHeight: 400,
        isScrolling: false
      })
    ).toBeNull()
  })

  it('does nothing before the virtualizer has an offset or while it is scrolling', () => {
    expect(
      getReconciledVirtualScrollOffset({
        believedOffset: null,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        isScrolling: false
      })
    ).toBeNull()
    expect(
      getReconciledVirtualScrollOffset({
        believedOffset: 70,
        scrollTop: 0,
        scrollHeight: 198,
        clientHeight: 285,
        isScrolling: true
      })
    ).toBeNull()
  })

  it('restores the first project header as the pinned one once the offset is reconciled', () => {
    // Regression: the virtualizer believed it sat at 70px while the element was at 0, so the
    // third header pinned in flow at the top over the first row and left a gap in its own slot.
    const rows = ['orca', 'Agentic-AI-Portal', 'BI-Portal-v2', 'Snowflake-REST-API'].map((key) =>
      makeHeaderRow(`repo:${key}`)
    )
    const rowHeight = GROUP_HEADER_ROW_HEIGHT + 4
    const virtualItems: VirtualItem[] = rows.map((row, index) => ({
      key: `hdr:${row.key}`,
      index,
      start: index * rowHeight,
      end: (index + 1) * rowHeight,
      size: rowHeight,
      lane: 0
    }))
    const stickyHeaderIndexes = [0, 1, 2, 3]
    const believedOffset = 70
    const staleRangeStartIndex = Math.floor(believedOffset / rowHeight)

    expect(
      getActiveStickyIndexesForScroll({
        rows,
        rangeStartIndex: staleRangeStartIndex,
        scrollOffset: believedOffset,
        stickyHeaderIndexes,
        virtualItems
      }).groupIndex
    ).toBe(2)

    const reconciled = getReconciledVirtualScrollOffset({
      believedOffset,
      scrollTop: 0,
      scrollHeight: rows.length * rowHeight,
      clientHeight: 285,
      isScrolling: false
    })
    expect(reconciled).toBe(0)
    expect(
      getActiveStickyIndexesForScroll({
        rows,
        rangeStartIndex: 0,
        scrollOffset: reconciled ?? believedOffset,
        stickyHeaderIndexes,
        virtualItems
      }).groupIndex
    ).toBe(0)
  })
})

describe('reconcileVirtualizerScrollOffset', () => {
  const unscrollableElement = { scrollTop: 0, scrollHeight: 198, clientHeight: 285 }

  it('waits out an in-flight scroll and re-anchors once it settles', () => {
    const virtualizer = { scrollOffset: 70, scrollAdjustments: 12, isScrolling: true }
    const scrollOffsetRef = { current: 70 }

    expect(
      reconcileVirtualizerScrollOffset({
        virtualizer,
        element: unscrollableElement,
        scrollOffsetRef
      })
    ).toBe(false)
    expect(virtualizer).toMatchObject({ scrollOffset: 70, scrollAdjustments: 12 })

    virtualizer.isScrolling = false
    expect(
      reconcileVirtualizerScrollOffset({
        virtualizer,
        element: unscrollableElement,
        scrollOffsetRef
      })
    ).toBe(true)
    expect(virtualizer).toMatchObject({ scrollOffset: 0, scrollAdjustments: 0 })
    expect(scrollOffsetRef.current).toBe(0)
  })

  it('reports no change when the belief is already where the element is', () => {
    const virtualizer = { scrollOffset: 0, scrollAdjustments: 0, isScrolling: false }
    expect(
      reconcileVirtualizerScrollOffset({
        virtualizer,
        element: unscrollableElement,
        scrollOffsetRef: { current: 0 }
      })
    ).toBe(false)
  })
})
