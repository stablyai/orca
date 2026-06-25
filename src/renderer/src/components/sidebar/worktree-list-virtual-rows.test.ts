import { describe, expect, it } from 'vitest'
import type { VirtualItem } from '@tanstack/react-virtual'
import {
  HOST_STICKY_PINNED_HEIGHT,
  extractWorktreeVirtualRowIndexes,
  getActiveStickyIndexesForScroll,
  getStickyHeaderIndexes,
  pruneStaleVirtualRowElementCache,
  type RenderRow
} from './worktree-list-virtual-rows'

function hostRow(hostId: string): RenderRow {
  return {
    type: 'host-header',
    key: `host:${hostId}`,
    hostId: hostId as never,
    kind: 'ssh',
    label: hostId,
    detail: 'SSH',
    health: 'available',
    collapsed: false,
    count: 1
  }
}

function groupRow(key: string): RenderRow {
  return { type: 'header', key, label: key, count: 1, tone: 'text-foreground' }
}

function itemStub(id: string): RenderRow {
  return { type: 'item', key: id } as unknown as RenderRow
}

function virtualItem(index: number, start: number): VirtualItem {
  return { index, start } as VirtualItem
}

// rows: [host-a, group-a1, item, item, host-b, group-b1, item]
const rows: RenderRow[] = [
  hostRow('a'),
  groupRow('a1'),
  itemStub('wt-1'),
  itemStub('wt-2'),
  hostRow('b'),
  groupRow('b1'),
  itemStub('wt-3')
]
const stickyHeaderIndexes = getStickyHeaderIndexes(rows)
// Geometry: each row 100px tall for easy math.
const virtualItems = rows.map((_, index) => virtualItem(index, index * 100))

describe('getActiveStickyIndexesForScroll', () => {
  it('pins the host and its inner group while scrolled inside a section', () => {
    expect(
      getActiveStickyIndexesForScroll({
        rows,
        rangeStartIndex: 2,
        scrollOffset: 250,
        stickyHeaderIndexes,
        virtualItems
      })
    ).toEqual({ hostIndex: 0, groupIndex: 1 })
  })

  it('hands the host tier off when the next host card reaches the top', () => {
    expect(
      getActiveStickyIndexesForScroll({
        rows,
        rangeStartIndex: 4,
        scrollOffset: 400,
        stickyHeaderIndexes,
        virtualItems
      })
    ).toMatchObject({ hostIndex: 4 })
  })

  it('never pins the previous host group beneath the next host card', () => {
    const result = getActiveStickyIndexesForScroll({
      rows,
      rangeStartIndex: 4,
      scrollOffset: 400,
      stickyHeaderIndexes,
      virtualItems
    })
    // group-a1 (index 1) must not survive into host b's tenure; group-b1 only
    // pins once it reaches the slot beneath the pinned host card.
    expect(result.groupIndex === 1).toBe(false)
  })

  it('offsets the group handoff by the pinned host height', () => {
    // group-b1 starts at 500; with host pinned it should activate once
    // scrollOffset + HOST_STICKY_PINNED_HEIGHT reaches 500.
    const before = getActiveStickyIndexesForScroll({
      rows,
      rangeStartIndex: 5,
      scrollOffset: 500 - HOST_STICKY_PINNED_HEIGHT - 1,
      stickyHeaderIndexes,
      virtualItems
    })
    const after = getActiveStickyIndexesForScroll({
      rows,
      rangeStartIndex: 5,
      scrollOffset: 500 - HOST_STICKY_PINNED_HEIGHT,
      stickyHeaderIndexes,
      virtualItems
    })
    expect(before.groupIndex).not.toBe(5)
    expect(after).toEqual({ hostIndex: 4, groupIndex: 5 })
  })

  it('degrades to single-tier rules when no host sections exist', () => {
    const flatRows: RenderRow[] = [
      groupRow('g1'),
      itemStub('wt-1'),
      groupRow('g2'),
      itemStub('wt-2')
    ]
    const flatSticky = getStickyHeaderIndexes(flatRows)
    const flatItems = flatRows.map((_, index) => virtualItem(index, index * 100))
    expect(
      getActiveStickyIndexesForScroll({
        rows: flatRows,
        rangeStartIndex: 1,
        scrollOffset: 150,
        stickyHeaderIndexes: flatSticky,
        virtualItems: flatItems
      })
    ).toEqual({ hostIndex: null, groupIndex: 0 })
  })
})

describe('extractWorktreeVirtualRowIndexes', () => {
  it('keeps the pinned host mounted even when scrolled out of range', () => {
    const indexes = extractWorktreeVirtualRowIndexes({
      range: {
        startIndex: 3,
        endIndex: 3,
        overscan: 0,
        count: rows.length,
        getItemIndex: (i: number) => i
      } as never,
      stickyHeaderIndexes,
      rows
    })
    expect(indexes).toContain(0)
  })
})

describe('pruneStaleVirtualRowElementCache', () => {
  it('removes stale measured row elements before they retain old WorktreeCard scopes', () => {
    const activeElement = {
      isConnected: true,
      getAttribute: (name: string) =>
        name === 'data-worktree-virtual-row-key' ? 'wt:active' : null
    } as Element
    const staleElement = {
      isConnected: false,
      getAttribute: (name: string) => (name === 'data-worktree-virtual-row-key' ? 'wt:stale' : null)
    } as Element
    const connectedStaleElement = {
      isConnected: true,
      getAttribute: (name: string) =>
        name === 'data-worktree-virtual-row-key' ? 'wt:connected-stale' : null
    } as Element
    const retainedScope = {
      defaultHostId: 'runtime:env-1',
      handlerName: 'handleOpenReviewInOrca'
    }
    Object.assign(staleElement, { __retainedWorktreeCardScopeForTest: retainedScope })

    const virtualizer = {
      elementsCache: new Map<string, Element>([
        ['wt:active', activeElement],
        ['wt:stale', staleElement],
        ['wt:connected-stale', connectedStaleElement]
      ]),
      measureElement: (element: Element | null) => {
        if (element) {
          throw new Error('stale cache pruning should not remeasure rows')
        }
      }
    }

    pruneStaleVirtualRowElementCache({
      activeRowKeys: new Set(['wt:active']),
      virtualizer
    })

    expect(virtualizer.elementsCache.get('wt:active')).toBe(activeElement)
    expect(virtualizer.elementsCache.has('wt:stale')).toBe(false)
    expect(virtualizer.elementsCache.get('wt:connected-stale')).toBe(connectedStaleElement)
  })
})
