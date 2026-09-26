import { Virtualizer } from '@tanstack/react-virtual'
import { describe, expect, it, vi } from 'vitest'
import { buildLineageVirtualTree } from '../listing/lineage-virtual-tree'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { getInitialLineageMeasurements } from './lineage-measurement-cache'
import { shouldAdjustWorktreeSidebarMeasuredRowScroll } from './use-scroll-suppression'

describe('restored lineage measurements', () => {
  it('seeds only measured keys in the current tree with their current order and origin', () => {
    const rows = [lineageRow('first'), lineageRow('unmeasured'), lineageRow('last')]
    const tree = buildLineageVirtualTree(rows)
    const heights = new Map([
      [rows[0]!.rowKey, 55],
      [rows[2]!.rowKey, 96],
      ['removed', 200]
    ])

    expect(getInitialLineageMeasurements(tree, heights, 1_000)).toEqual([
      { key: rows[0]!.rowKey, index: 0, start: 1_000, size: 55, end: 1_055, lane: 0 },
      { key: rows[2]!.rowKey, index: 2, start: 1_151, size: 96, end: 1_247, lane: 0 }
    ])
    expect(getInitialLineageMeasurements(tree, new Map(), 1_000)).toEqual([])
    expect(heights.size).toBe(3)
  })

  it('keeps same-id rows on different hosts separate', () => {
    const local = lineageRow('same')
    const remote = { ...lineageRow('same'), rowKey: 'all:ssh-host|same' }
    const tree = buildLineageVirtualTree([remote, local])
    const measurements = getInitialLineageMeasurements(tree, new Map([[local.rowKey, 55]]), 0)

    expect(measurements).toEqual([
      { key: local.rowKey, index: 1, start: 96, size: 55, end: 151, lane: 0 }
    ])
  })

  it.each([
    { previousSize: 55, scrollOffset: 20, measured: true, adjusts: false },
    { previousSize: 96, scrollOffset: 20, measured: true, adjusts: false },
    { previousSize: 55, scrollOffset: 100, measured: true, adjusts: true },
    { previousSize: 96, scrollOffset: 20, measured: false, adjusts: true }
  ])('preserves measured versus first-measure fold policy: %j', (scenario) => {
    const row = lineageRow('child')
    const tree = buildLineageVirtualTree([row])
    const heights = new Map(scenario.measured ? [[row.rowKey, scenario.previousSize]] : [])
    const scrollTo = vi.fn()
    const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 1,
      getScrollElement: () => null,
      getItemKey: () => row.rowKey,
      estimateSize: () => scenario.previousSize,
      initialOffset: scenario.scrollOffset,
      initialMeasurementsCache: getInitialLineageMeasurements(tree, heights, 0),
      scrollToFn: scrollTo,
      observeElementRect: vi.fn(),
      observeElementOffset: vi.fn()
    })
    instance.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, owner) =>
      shouldAdjustWorktreeSidebarMeasuredRowScroll({
        isScrolling: owner.isScrolling,
        now: 1_000,
        suppressUntil: 0,
        itemStart: item.start,
        itemEnd: item.end,
        scrollOffset: (owner.scrollOffset ?? 0) + owner.scrollAdjustments,
        isFirstMeasurement: !owner.itemSizeCache.has(item.key),
        scrollDirection: owner.scrollDirection
      })
    expect(instance.getTotalSize()).toBe(scenario.previousSize)
    expect(instance.itemSizeCache.has(row.rowKey)).toBe(scenario.measured)

    instance.resizeItem(0, scenario.previousSize + 30)

    expect(scrollTo).toHaveBeenCalledTimes(scenario.adjusts ? 1 : 0)
    expect(instance.getTotalSize()).toBe(scenario.previousSize + 30)
    expect(instance.itemSizeCache.get(row.rowKey)).toBe(scenario.previousSize + 30)
  })
})
