import { describe, expect, it } from 'vitest'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  HOST_HEADER_INNER_TOP_PADDING,
  HOST_STICKY_GROUP_TOP_PX,
  HOST_STICKY_PINNED_HEIGHT,
  buildLineageRowRekeyMap,
  estimateRenderRowSize,
  extractWorktreeVirtualRowIndexes,
  getActiveStickyIndexesForScroll,
  getStickyHeaderIndexes,
  getVirtualRowIndexAtOffset,
  pruneStaleVirtualRowElementCache
} from './virtual-rows'
import {
  clampInitialVirtualScrollOffset,
  estimateRenderRowsTotalSize
} from './initial-scroll-offset'
import { getRenderRowKey } from '../listing/render-row'
import type { RenderRow } from '../listing/render-row'

function hostRow(hostId: ExecutionHostId): RenderRow {
  return {
    type: 'host-header',
    key: `host:${hostId}`,
    hostId,
    kind: 'ssh',
    label: hostId,
    detail: 'SSH',
    health: 'available',
    collapsed: false,
    count: 1
  }
}

function groupRow(key: string, hostId?: ExecutionHostId): RenderRow {
  return {
    type: 'header',
    key,
    label: key,
    count: 1,
    tone: 'text-foreground',
    ...(hostId ? { hostId } : {})
  }
}

function itemStub(id: string): RenderRow {
  return { type: 'item', key: id } as unknown as RenderRow
}

function virtualItem(index: number, start: number): VirtualItem {
  return { index, start } as VirtualItem
}

// rows: [host-a, group-a1, item, item, host-b, group-b1, item]
const rows: RenderRow[] = [
  hostRow('ssh:a'),
  groupRow('a1'),
  itemStub('wt-1'),
  itemStub('wt-2'),
  hostRow('ssh:b'),
  groupRow('b1'),
  itemStub('wt-3')
]
const stickyHeaderIndexes = getStickyHeaderIndexes(rows)
// Geometry: each row 100px tall for easy math.
const virtualItems = rows.map((_, index) => virtualItem(index, index * 100))

describe('getRenderRowKey', () => {
  it('scopes repeated group headers to their host section', () => {
    expect(getRenderRowKey(groupRow('workspace-status:in-progress', 'local'))).toBe(
      'hdr:local:workspace-status:in-progress'
    )
    expect(getRenderRowKey(groupRow('workspace-status:in-progress', 'ssh:builder'))).toBe(
      'hdr:ssh:builder:workspace-status:in-progress'
    )
  })

  it('preserves unsectioned group header keys', () => {
    expect(getRenderRowKey(groupRow('workspace-status:in-progress'))).toBe(
      'hdr:workspace-status:in-progress'
    )
  })
})

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

  it('clamps stale remount offsets when collapsed hosts fit the viewport', () => {
    const collapsedRows = Array.from({ length: 20 }, (_, index) => hostRow(`ssh:${index}`))
    const measurements = collapsedRows.map((_, index) => virtualItem(index, index * 38))
    // The stale end range omits row 0 even though the clamped offset is 0.
    const mountedItems = measurements.slice(9)

    expect(
      getActiveStickyIndexesForScroll({
        rows: collapsedRows,
        rangeStartIndex: 19,
        scrollOffset: 500,
        maxScrollOffset: 0,
        stickyHeaderIndexes: getStickyHeaderIndexes(collapsedRows),
        virtualItems: mountedItems,
        rangeStartIndexAtMaxScrollOffset: 0
      })
    ).toEqual({ hostIndex: 0, groupIndex: null })
  })

  it('clamps the initial offset before TanStack selects a stale remount range', () => {
    const collapsedRows = Array.from({ length: 20 }, (_, index) => hostRow(`ssh:${index}`))

    expect(
      clampInitialVirtualScrollOffset({
        requestedOffset: 500,
        estimatedTotalSize: estimateRenderRowsTotalSize(collapsedRows, 0),
        viewportHeight: 1_000
      })
    ).toBe(0)
  })

  it('preserves a reachable initial remount offset', () => {
    expect(
      clampInitialVirtualScrollOffset({
        requestedOffset: 250,
        estimatedTotalSize: 1_000,
        viewportHeight: 500
      })
    ).toBe(250)
  })

  it('leaves reachable offsets unchanged when a maximum is provided', () => {
    expect(
      getActiveStickyIndexesForScroll({
        rows,
        rangeStartIndex: 2,
        scrollOffset: 250,
        maxScrollOffset: 600,
        stickyHeaderIndexes,
        virtualItems
      })
    ).toEqual({ hostIndex: 0, groupIndex: 1 })
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

  it('does not pin a Project header whose virtual item is not mounted yet (#10088)', () => {
    // Why: after scrollToIndex/reveal, rangeStart can sit on group-b1 while
    // TanStack has only mounted host-b (and maybe a later item) this frame.
    const partialItems = [virtualItem(4, 400), virtualItem(6, 600)]
    const result = getActiveStickyIndexesForScroll({
      rows,
      rangeStartIndex: 5,
      scrollOffset: 500,
      stickyHeaderIndexes,
      virtualItems: partialItems
    })
    expect(result.hostIndex).toBe(4)
    // group-b1 (index 5) must not become sticky without geometry — that is what
    // paints the project label across the host card.
    expect(result.groupIndex).toBeNull()
  })

  it('keeps the previous mounted Project sticky when the next group is unmounted', () => {
    const multiGroupRows: RenderRow[] = [
      hostRow('ssh:a'),
      groupRow('a1'),
      itemStub('wt-1'),
      groupRow('a2'),
      itemStub('wt-2')
    ]
    const multiSticky = getStickyHeaderIndexes(multiGroupRows)
    // rangeStart points at a2 (index 3) but only host + a1 + item are mounted.
    const partialItems = [virtualItem(0, 0), virtualItem(1, 100), virtualItem(2, 200)]
    const result = getActiveStickyIndexesForScroll({
      rows: multiGroupRows,
      rangeStartIndex: 3,
      scrollOffset: 250,
      stickyHeaderIndexes: multiSticky,
      virtualItems: partialItems
    })
    expect(result.hostIndex).toBe(0)
    expect(result.groupIndex).toBe(1)
  })

  it('estimates host headers with HostSectionHeader inner padding so sticky geometry matches paint (#12300)', () => {
    // Why: HostSectionHeader is always pt-1 + h-8. Under-estimating the first host
    // by 4px pulled later group starts forward and made sticky tiers collide.
    const multiGroupRows: RenderRow[] = [
      hostRow('ssh:a'),
      groupRow('a1'),
      itemStub('wt-1'),
      hostRow('ssh:b'),
      groupRow('b1'),
      itemStub('wt-2')
    ]
    expect(HOST_HEADER_INNER_TOP_PADDING).toBe(4)
    expect(HOST_STICKY_PINNED_HEIGHT).toBe(36)
    expect(estimateRenderRowSize(multiGroupRows, 0, 0, null)).toBe(36)
    expect(estimateRenderRowSize(multiGroupRows, 3, 0, null)).toBe(40)
    expect(HOST_STICKY_GROUP_TOP_PX).toBe(35)

    const multiSticky = getStickyHeaderIndexes(multiGroupRows)
    const gap = 6
    const hostSize = estimateRenderRowSize(multiGroupRows, 0, 0, null)
    const groupStart = hostSize + gap
    const virtualItems = [
      virtualItem(0, 0),
      virtualItem(1, groupStart),
      virtualItem(2, groupStart + 100),
      virtualItem(3, groupStart + 200),
      virtualItem(4, groupStart + 300),
      virtualItem(5, groupStart + 400)
    ]

    // Cold first paint: host pin only; first group stays in flow.
    const cold = getActiveStickyIndexesForScroll({
      rows: multiGroupRows,
      rangeStartIndex: 0,
      scrollOffset: 0,
      stickyHeaderIndexes: multiSticky,
      virtualItems
    })
    expect(cold).toEqual({ hostIndex: 0, groupIndex: null })

    // Group must not pin until scrollOffset + HOST_STICKY_PINNED_HEIGHT reaches start.
    const earlyScroll = groupStart - HOST_STICKY_PINNED_HEIGHT - 1
    const early = getActiveStickyIndexesForScroll({
      rows: multiGroupRows,
      rangeStartIndex: 1,
      scrollOffset: earlyScroll,
      stickyHeaderIndexes: multiSticky,
      virtualItems
    })
    expect(early.groupIndex).toBeNull()

    const onSlot = getActiveStickyIndexesForScroll({
      rows: multiGroupRows,
      rangeStartIndex: 1,
      scrollOffset: groupStart - HOST_STICKY_PINNED_HEIGHT,
      stickyHeaderIndexes: multiSticky,
      virtualItems
    })
    expect(onSlot).toEqual({ hostIndex: 0, groupIndex: 1 })
  })

  it('keeps single-tier cold first render free of double group pins', () => {
    const flatRows: RenderRow[] = [
      groupRow('project-group:infra'),
      itemStub('wt-1'),
      groupRow('project-group:projects'),
      itemStub('wt-2')
    ]
    const flatSticky = getStickyHeaderIndexes(flatRows)
    const sizes = flatRows.map((_, index) => estimateRenderRowSize(flatRows, index, 0, null))
    let start = 0
    const flatItems = sizes.map((size, index) => {
      const item = virtualItem(index, start)
      start += size + 6
      return item
    })

    const cold = getActiveStickyIndexesForScroll({
      rows: flatRows,
      rangeStartIndex: 0,
      scrollOffset: 0,
      stickyHeaderIndexes: flatSticky,
      virtualItems: flatItems
    })
    expect(cold).toEqual({ hostIndex: null, groupIndex: 0 })

    // Second group must not share the pin until it reaches the top.
    const mid = getActiveStickyIndexesForScroll({
      rows: flatRows,
      rangeStartIndex: 1,
      scrollOffset: flatItems[2].start - 1,
      stickyHeaderIndexes: flatSticky,
      virtualItems: flatItems
    })
    expect(mid.groupIndex).toBe(0)
  })

  it('scopes host-stamped project-group header keys so multi-host sections stay unique', () => {
    expect(getRenderRowKey(groupRow('project-group:infra', 'local'))).toBe(
      'hdr:local:project-group:infra'
    )
    expect(getRenderRowKey(groupRow('project-group:infra', 'ssh:builder'))).toBe(
      'hdr:ssh:builder:project-group:infra'
    )
    expect(getRenderRowKey(groupRow('project-group:infra'))).toBe('hdr:project-group:infra')
  })
})

describe('getVirtualRowIndexAtOffset', () => {
  it('returns the last row at or before the offset', () => {
    expect(getVirtualRowIndexAtOffset([virtualItem(2, 20), virtualItem(3, 60)], 60)).toBe(3)
    expect(getVirtualRowIndexAtOffset([virtualItem(2, 20), virtualItem(3, 60)], 59)).toBe(2)
  })

  it('falls back to the first row when the offset precedes the mounted window', () => {
    expect(getVirtualRowIndexAtOffset([virtualItem(9, 342), virtualItem(10, 380)], 0)).toBe(9)
    expect(getVirtualRowIndexAtOffset([], 0)).toBeNull()
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

describe('buildLineageRowRekeyMap', () => {
  // Mirrors buildWorktreeRow: rowKey is `${sectionKey}:${worktree.id}`.
  function worktreeRow(sectionKey: string, worktreeId: string): RenderRow {
    return {
      type: 'item',
      rowKey: `${sectionKey}:${worktreeId}`,
      sectionKey,
      worktree: { id: worktreeId },
      depth: 0,
      groupDepth: 0,
      lineageTrail: [],
      isLastLineageChild: true,
      lineageChildCount: 0
    } as unknown as RenderRow
  }

  function lineageGroupRow(sectionKey: string, parentId: string, childIds: string[]): RenderRow {
    return {
      type: 'lineage-group',
      key: `${sectionKey}:lineage:${parentId}`,
      rows: [parentId, ...childIds].map(
        (id) => worktreeRow(sectionKey, id) as Extract<RenderRow, { type: 'item' }>
      )
    }
  }

  it('folds every lineage-group member onto the group key', () => {
    const group = lineageGroupRow('all', 'p', ['c1', 'c2'])
    const rekeys = buildLineageRowRekeyMap([group])

    // The parent's own row key is what an anchor recorded before the child
    // existed; all members now live inside the single group row.
    expect(rekeys.get('wt:all:p')).toBe('lineage-group:all:lineage:p')
    expect(rekeys.get('wt:all:c1')).toBe('lineage-group:all:lineage:p')
    expect(rekeys.get('wt:all:c2')).toBe('lineage-group:all:lineage:p')
    expect(getRenderRowKey(group)).toBe('lineage-group:all:lineage:p')
  })

  it('dissolves a group key back onto the plain item row', () => {
    // Last child deleted: lineageChildCount is already 0, but an anchor still
    // holds the group key, so the reverse mapping must be unguarded.
    const rekeys = buildLineageRowRekeyMap([worktreeRow('all', 'p')])

    expect(rekeys.get('lineage-group:all:lineage:p')).toBe('wt:all:p')
  })

  it('round-trips the fold and dissolve directions for the same worktree', () => {
    const folded = buildLineageRowRekeyMap([lineageGroupRow('all', 'p', ['c1'])])
    const dissolved = buildLineageRowRekeyMap([worktreeRow('all', 'p')])

    expect(dissolved.get(folded.get('wt:all:p') as string)).toBe('wt:all:p')
  })

  it('keeps the same worktree distinct across sections', () => {
    // The same worktree renders in both Pinned and All; rowKey embeds the
    // section so a pinned anchor must never follow the All copy.
    const rekeys = buildLineageRowRekeyMap([
      lineageGroupRow('pinned', 'p', ['c1']),
      lineageGroupRow('all', 'p', ['c1'])
    ])

    expect(rekeys.get('wt:pinned:p')).toBe('lineage-group:pinned:lineage:p')
    expect(rekeys.get('wt:all:p')).toBe('lineage-group:all:lineage:p')
    expect(rekeys.get('wt:pinned:c1')).toBe('lineage-group:pinned:lineage:p')
    expect(rekeys.get('wt:all:c1')).toBe('lineage-group:all:lineage:p')

    const dissolvedRekeys = buildLineageRowRekeyMap([
      worktreeRow('pinned', 'p'),
      worktreeRow('all', 'p')
    ])
    expect(dissolvedRekeys.get('lineage-group:pinned:lineage:p')).toBe('wt:pinned:p')
    expect(dissolvedRekeys.get('lineage-group:all:lineage:p')).toBe('wt:all:p')
  })

  it('contributes nothing for non-lineage row types', () => {
    expect(
      buildLineageRowRekeyMap([hostRow('ssh:a'), groupRow('a1'), hostRow('ssh:b'), groupRow('b1')])
        .size
    ).toBe(0)
  })

  it('is empty for an empty row list', () => {
    expect(buildLineageRowRekeyMap([]).size).toBe(0)
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
