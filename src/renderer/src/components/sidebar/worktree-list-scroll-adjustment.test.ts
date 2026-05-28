import { describe, expect, it, vi } from 'vitest'
import {
  countRecordKeysByReference,
  getScrollTopToRevealBounds,
  resolvePendingSidebarReveal,
  WORKTREE_SIDEBAR_REVEAL_TOP_INSET,
  shouldAdjustWorktreeSidebarMeasuredRowScroll
} from './WorktreeList'
import {
  estimateRenderRowSize,
  GROUP_HEADER_ROW_HEIGHT,
  getActiveStickyHeaderIndexForScroll
} from './worktree-list-virtual-rows'

const makeHeaderRow = (key: string) =>
  ({
    type: 'header',
    key,
    label: key,
    count: 0,
    tone: 'text-foreground'
  }) as const

const makeScrollContainer = (scrollTop: number, clientHeight: number): HTMLElement =>
  ({ scrollTop, clientHeight }) as HTMLElement

describe('shouldAdjustWorktreeSidebarMeasuredRowScroll', () => {
  it('counts record keys once per object reference', () => {
    const keysSpy = vi.spyOn(Object, 'keys')
    const first = { a: 1, b: 2 }
    const second = { ...first, c: 3 }

    try {
      expect(countRecordKeysByReference(first)).toBe(2)
      expect(countRecordKeysByReference(first)).toBe(2)
      expect(countRecordKeysByReference(second)).toBe(3)
      expect(keysSpy).toHaveBeenCalledTimes(2)
    } finally {
      keysSpy.mockRestore()
    }
  })

  it('suppresses measured-row scroll correction while TanStack is scrolling', () => {
    expect(
      shouldAdjustWorktreeSidebarMeasuredRowScroll({
        isScrolling: true,
        now: 1_000,
        suppressUntil: 0
      })
    ).toBe(false)
  })

  it('suppresses measured-row scroll correction during direct scroll input grace period', () => {
    expect(
      shouldAdjustWorktreeSidebarMeasuredRowScroll({
        isScrolling: false,
        now: 1_000,
        suppressUntil: 1_250
      })
    ).toBe(false)
  })

  it('allows measured-row scroll correction after direct scrolling settles', () => {
    expect(
      shouldAdjustWorktreeSidebarMeasuredRowScroll({
        isScrolling: false,
        now: 1_500,
        suppressUntil: 1_250
      })
    ).toBe(true)
  })

  it('keeps pending reveal requests when the worktree still exists but the row is unresolved', () => {
    expect(
      resolvePendingSidebarReveal({
        targetIndex: -1,
        targetWorktreeStillExists: true
      })
    ).toBe('keep-pending')
  })

  it('clears pending reveal requests once the target disappears', () => {
    expect(
      resolvePendingSidebarReveal({
        targetIndex: -1,
        targetWorktreeStillExists: false
      })
    ).toBe('clear')
  })

  it('scrolls and clears once the target row is resolvable', () => {
    expect(
      resolvePendingSidebarReveal({
        targetIndex: 4,
        targetWorktreeStillExists: true
      })
    ).toBe('scroll-and-clear')
  })
})

describe('getScrollTopToRevealBounds', () => {
  it('treats the sticky header as occluding the viewport top', () => {
    const container = makeScrollContainer(100, 400)

    expect(
      getScrollTopToRevealBounds(
        container,
        {
          start: 100,
          end: 216
        },
        GROUP_HEADER_ROW_HEIGHT
      )
    ).toBe(72)
  })

  it('includes extra reveal clearance for the highlight ring', () => {
    const container = makeScrollContainer(100, 400)

    expect(
      getScrollTopToRevealBounds(
        container,
        {
          start: 100,
          end: 216
        },
        WORKTREE_SIDEBAR_REVEAL_TOP_INSET
      )
    ).toBe(66)
  })

  it('does not scroll when the bounds are below the sticky header', () => {
    const container = makeScrollContainer(100, 400)

    expect(
      getScrollTopToRevealBounds(
        container,
        {
          start: 128,
          end: 244
        },
        GROUP_HEADER_ROW_HEIGHT
      )
    ).toBeNull()
  })

  it('keeps the viewport bottom independent of the sticky header inset', () => {
    const container = makeScrollContainer(100, 400)

    expect(
      getScrollTopToRevealBounds(
        container,
        {
          start: 430,
          end: 520
        },
        GROUP_HEADER_ROW_HEIGHT
      )
    ).toBe(120)
  })
})

describe('estimateRenderRowSize', () => {
  it('keeps secondary group header size stable while it is the active sticky header', () => {
    const rows = [makeHeaderRow('first'), makeHeaderRow('second')]
    const firstHeaderIndex = 0
    const secondaryHeaderIndex = 1
    const inactiveSize = estimateRenderRowSize(rows, secondaryHeaderIndex, firstHeaderIndex, null)
    const activeSize = estimateRenderRowSize(
      rows,
      secondaryHeaderIndex,
      firstHeaderIndex,
      secondaryHeaderIndex
    )

    expect(inactiveSize).toBe(36)
    expect(activeSize).toBe(36)
  })

  it('keeps the previous header active while a secondary header spacer crosses the top', () => {
    const rows = [makeHeaderRow('first'), makeHeaderRow('second')]

    expect(
      getActiveStickyHeaderIndexForScroll({
        firstHeaderIndex: 0,
        rangeStartIndex: 1,
        rows,
        scrollOffset: 100,
        stickyHeaderIndexes: [0, 1],
        virtualItems: [{ key: 'hdr:second', index: 1, start: 100, end: 136, size: 36, lane: 0 }]
      })
    ).toBe(0)
  })

  it('activates a secondary header once its painted header reaches the top', () => {
    const rows = [makeHeaderRow('first'), makeHeaderRow('second')]

    expect(
      getActiveStickyHeaderIndexForScroll({
        firstHeaderIndex: 0,
        rangeStartIndex: 1,
        rows,
        scrollOffset: 108,
        stickyHeaderIndexes: [0, 1],
        virtualItems: [{ key: 'hdr:second', index: 1, start: 100, end: 136, size: 36, lane: 0 }]
      })
    ).toBe(1)
  })
})
