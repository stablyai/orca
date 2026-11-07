import { describe, expect, it } from 'vitest'
import {
  buildTreemapLayout,
  groupSmallTreemapItems,
  resolveTreemapLabelTier,
  type TreemapInput,
  type TreemapRect
} from './workspace-space-layout'

const GB = 1024 ** 3
const MB = 1024 ** 2

describe('buildTreemapLayout', () => {
  it('lays out positive-size items inside a 100x100 treemap', () => {
    const rects = buildTreemapLayout([
      { id: 'a', label: 'A', sizeBytes: 60 },
      { id: 'b', label: 'B', sizeBytes: 30 },
      { id: 'c', label: 'C', sizeBytes: 10 },
      { id: 'empty', label: 'Empty', sizeBytes: 0 }
    ])

    expect(rects.map((rect) => rect.id)).toEqual(['a', 'b', 'c'])
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(100)
      expect(rect.y + rect.height).toBeLessThanOrEqual(100)
    }
    const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0)
    expect(area).toBeCloseTo(10_000, 5)
    expect(rects[0].width * rects[0].height).toBeGreaterThan(rects[1].width * rects[1].height)
  })

  it('makes the largest boxes closer to square on a wide chart when given its aspect ratio', () => {
    // Workspace sizes from the Space window report: five large worktrees and a tail of small ones.
    const items: TreemapInput[] = [
      9.8 * GB,
      8.27 * GB,
      7.22 * GB,
      6.96 * GB,
      4.01 * GB,
      180 * MB,
      150 * MB,
      120 * MB,
      90 * MB,
      60 * MB,
      40 * MB,
      20 * MB
    ].map((sizeBytes, index) => ({ id: `w${index}`, label: `w${index}`, sizeBytes }))
    const chartAspectRatio = 6
    // Long side ÷ short side in pixels on a chart that is 6 times wider than tall.
    const pixelFlatness = (rect: TreemapRect): number => {
      const ratio = (rect.width * chartAspectRatio) / rect.height
      return Math.max(ratio, 1 / ratio)
    }

    const squareLayout = buildTreemapLayout(items)
    const wideLayout = buildTreemapLayout(items, chartAspectRatio)

    for (const index of [0, 1, 2, 3]) {
      expect(wideLayout[index].id).toBe(squareLayout[index].id)
      expect(pixelFlatness(wideLayout[index])).toBeLessThan(pixelFlatness(squareLayout[index]))
    }
    expect(pixelFlatness(wideLayout[0])).toBeLessThan(2)
  })

  it('places a grouped item last even when it is larger than a real item', () => {
    const rects = buildTreemapLayout([
      { id: 'group', label: '', sizeBytes: 40, groupedLabels: ['c', 'd'] },
      { id: 'a', label: 'A', sizeBytes: 50 },
      { id: 'b', label: 'B', sizeBytes: 10 }
    ])

    expect(rects.map((rect) => rect.id)).toEqual(['a', 'b', 'group'])
  })
})

describe('groupSmallTreemapItems', () => {
  it('folds two or more items under 1% of the total into one item listing their names', () => {
    const grouped = groupSmallTreemapItems([
      { id: 'big', label: 'Big', sizeBytes: 9_700 },
      { id: 'small-1', label: 'Small 1', sizeBytes: 90 },
      { id: 'mid', label: 'Mid', sizeBytes: 150 },
      { id: 'small-2', label: 'Small 2', sizeBytes: 60 },
      { id: 'empty', label: 'Empty', sizeBytes: 0 }
    ])

    expect(grouped.map((item) => item.id).slice(0, 2)).toEqual(['big', 'mid'])
    expect(grouped).toHaveLength(3)
    expect(grouped[2]).toMatchObject({ sizeBytes: 150, groupedLabels: ['Small 1', 'Small 2'] })
    expect(['big', 'mid', 'small-1', 'small-2', 'empty']).not.toContain(grouped[2].id)
  })

  it('keeps a single small item as is', () => {
    const items: TreemapInput[] = [
      { id: 'big', label: 'Big', sizeBytes: 9_950 },
      { id: 'small', label: 'Small', sizeBytes: 50 }
    ]

    expect(groupSmallTreemapItems(items)).toEqual(items)
  })

  it('keeps the selected item out of the group so it stays visible', () => {
    const grouped = groupSmallTreemapItems(
      [
        { id: 'big', label: 'Big', sizeBytes: 9_800 },
        { id: 'selected', label: 'Selected', sizeBytes: 70 },
        { id: 'small-1', label: 'Small 1', sizeBytes: 70 },
        { id: 'small-2', label: 'Small 2', sizeBytes: 60 }
      ],
      'selected'
    )

    expect(grouped.map((item) => item.id).slice(0, 2)).toEqual(['big', 'selected'])
    expect(grouped[2]).toMatchObject({ groupedLabels: ['Small 1', 'Small 2'] })
  })

  it('does not group when every item is under 1%, so the chart never becomes one box', () => {
    const items: TreemapInput[] = Array.from({ length: 150 }, (_, index) => ({
      id: `dir-${index}`,
      label: `dir-${index}`,
      sizeBytes: 100
    }))

    expect(groupSmallTreemapItems(items)).toEqual(items)
  })
})

describe('resolveTreemapLabelTier', () => {
  it('hides the label when a wide box is too short for one line', () => {
    // The ssh-relay-auth box from the bug report: half of "4.01 GB" was drawn at this size.
    expect(resolveTreemapLabelTier(463, 28)).toBe('none')
  })

  it('shows only the name when there is room for one line but not two', () => {
    expect(resolveTreemapLabelTier(463, 44)).toBe('name')
  })

  it('shows the name and size when both lines fit', () => {
    expect(resolveTreemapLabelTier(463, 48)).toBe('name-and-size')
  })

  it('shows only the name in a tall box too narrow for the size', () => {
    expect(resolveTreemapLabelTier(55, 100)).toBe('name')
  })

  it('hides the label in a box too narrow for a readable name', () => {
    expect(resolveTreemapLabelTier(40, 100)).toBe('none')
  })
})
