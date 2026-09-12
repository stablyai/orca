// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { VirtualItem } from '@tanstack/react-virtual'
import { useVirtualRowMeasurementSync } from './use-row-measurement'
import { getStickyHeaderIndexes } from './virtual-rows'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeListVirtualizer } from './use-virtualizer'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'

/**
 * STA-6697 at the CALL SITE.
 *
 * virtual-rows.test.ts pins `resolveStickyScrollOffset` itself, but every one of those tests
 * builds the offset by calling the helper directly and hands the result to the resolver. None of
 * them runs this hook, which is where the fix actually lives — so reverting this file to
 * `virtualizer.scrollOffset ?? scrollOffsetRef.current` left the whole sidebar suite green while
 * shipping the bug. This is the test that fails on that revert.
 */

// Minimal but real: buildLineageRowRekeyMap reads `sectionKey` and the worktree's lineage fields.
function itemRow(id: string, sectionKey: string): RenderRow {
  return {
    type: 'item',
    key: id,
    sectionKey,
    worktree: { id, path: `/tmp/${id}`, branch: id }
  } as unknown as RenderRow
}

// Two projects, collapsed, in a list too short to scroll: header, row, header, row.
const rows: RenderRow[] = [
  { type: 'header', key: 'project-a', label: 'project-a', count: 1, tone: 'text-foreground' },
  itemRow('wt-a', 'project-a'),
  { type: 'header', key: 'project-b', label: 'project-b', count: 1, tone: 'text-foreground' },
  itemRow('wt-b', 'project-b')
]
const virtualItems = [
  { index: 0, start: 0 },
  { index: 1, start: 36 },
  { index: 2, start: 70 },
  { index: 3, start: 106 }
] as VirtualItem[]

/** The believed offset a post-mount size correction books while the element stays at 0. */
const DRIFTED_OFFSET = 70

function createScrollElement(scrollTop: number): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  // Models the defect's defining property: the list is too short to scroll, so the browser clamps
  // any write and the element never moves. That immovability is precisely why the virtualizer's
  // remembered offset can drift away and never resync — nothing fires a scroll event to correct it.
  //
  // Honest about its reach: the current assertions do not observe this. The scroll-anchor listener
  // writes scrollTop once from a layout effect, after the render that computes the sticky index,
  // so a plain writable property passes these tests identically. It is kept because a fixture
  // whose element CAN move is the one least likely to catch the half of this defect that is still
  // open — the range start is still chosen from the drifted offset.
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: () => undefined
  })
  return element
}

function renderMeasurementSync(args: { scrollTop: number; virtualizerOffset: number | null }) {
  const activeStickyHeaderIndexRef = { current: null as number | null }
  const virtualization = {
    virtualizer: {
      scrollOffset: args.virtualizerOffset,
      elementsCache: new Map<string, Element>(),
      getTotalSize: () => 142,
      getVirtualItems: () => virtualItems,
      measureElement: () => undefined
    },
    isCurrentVirtualRowElement: () => true,
    stickyHeaderIndexes: getStickyHeaderIndexes(rows),
    activeStickyHeaderIndexRef,
    activeStickyHostIndexRef: { current: null as number | null },
    // Drift also advanced the virtualizer's range, so the candidate handed in is already project B.
    stickyRangeStartIndexRef: { current: 2 }
  } as unknown as WorktreeListVirtualizer

  const scrollRef = { current: createScrollElement(args.scrollTop) }
  const view = renderHook(() =>
    useVirtualRowMeasurementSync({
      renderRows: rows,
      virtualization,
      scrollRef,
      scrollOffsetRef: { current: DRIFTED_OFFSET },
      scrollAnchorRef: { current: {} as VirtualizedScrollAnchor },
      hasDirectScrollInput: () => false,
      shouldSkipScrollAnchorRestore: () => true
    })
  )
  return { activeStickyHeaderIndexRef, view }
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('useVirtualRowMeasurementSync sticky offset', () => {
  it('pins the header the element is actually showing, not the drifted one (STA-6697)', () => {
    const { activeStickyHeaderIndexRef } = renderMeasurementSync({
      scrollTop: 0,
      virtualizerOffset: DRIFTED_OFFSET
    })

    // Project A fills the viewport, so Project A stays pinned. Pinning B paints it over row 0
    // and leaves B's own slot blank — the reported gap.
    expect(activeStickyHeaderIndexRef.current).toBe(0)
  })

  it('promotes the second project once the element has really scrolled', () => {
    const { activeStickyHeaderIndexRef } = renderMeasurementSync({
      scrollTop: DRIFTED_OFFSET,
      virtualizerOffset: DRIFTED_OFFSET
    })

    // Guards the test above against passing for a setup reason: the hook does run, does write the
    // ref, and does promote when the element genuinely moved.
    expect(activeStickyHeaderIndexRef.current).toBe(2)
  })
})
