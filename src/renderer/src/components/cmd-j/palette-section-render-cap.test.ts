import { describe, expect, it } from 'vitest'
import {
  capPaletteSection,
  layoutMultiPrimaryPaletteSections,
  orderMultiPrimaryPaletteItems,
  PALETTE_SECTION_RENDER_CAP,
  softSplitPaletteSection,
  TYPED_QUERY_LEADING_PREVIEW,
  TYPED_QUERY_TRAILING_FLOOR
} from './palette-section-render-cap'

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index)

describe('capPaletteSection', () => {
  it('returns the original array reference when nothing overflows', () => {
    const items = range(PALETTE_SECTION_RENDER_CAP)

    const capped = capPaletteSection(items)

    expect(capped.visible).toBe(items)
    expect(capped.overflowCount).toBe(0)
  })

  it('keeps the top matches and reports the remainder', () => {
    const capped = capPaletteSection(range(448))

    expect(capped.visible).toHaveLength(PALETTE_SECTION_RENDER_CAP)
    expect(capped.visible[0]).toBe(0)
    expect(capped.visible.at(-1)).toBe(PALETTE_SECTION_RENDER_CAP - 1)
    expect(capped.overflowCount).toBe(448 - PALETTE_SECTION_RENDER_CAP)
  })

  it('handles an empty section', () => {
    expect(capPaletteSection([])).toEqual({ visible: [], overflowCount: 0 })
  })

  it('ignores a nonsensical cap rather than rendering nothing', () => {
    const items = range(3)

    expect(capPaletteSection(items, -1).visible).toBe(items)
    expect(capPaletteSection(items, Number.NaN).visible).toBe(items)
  })

  it('supports an explicit cap of zero', () => {
    expect(capPaletteSection(range(3), 0)).toEqual({ visible: [], overflowCount: 3 })
  })
})

describe('softSplitPaletteSection', () => {
  it('splits under the hard cap and reports everything after the preview', () => {
    const split = softSplitPaletteSection(range(12), TYPED_QUERY_LEADING_PREVIEW)

    expect(split.preview).toEqual(range(6))
    expect(split.rest).toEqual([6, 7, 8, 9, 10, 11])
    expect(split.moreCount).toBe(6)
  })

  it('includes hard-cap overflow in moreCount without rendering it', () => {
    const split = softSplitPaletteSection(range(80), TYPED_QUERY_LEADING_PREVIEW)

    expect(split.preview).toHaveLength(TYPED_QUERY_LEADING_PREVIEW)
    expect(split.rest).toHaveLength(PALETTE_SECTION_RENDER_CAP - TYPED_QUERY_LEADING_PREVIEW)
    expect(split.moreCount).toBe(80 - TYPED_QUERY_LEADING_PREVIEW)
  })

  it('keeps short sections intact with no remainder', () => {
    const items = range(3)
    const split = softSplitPaletteSection(items, TYPED_QUERY_LEADING_PREVIEW)

    expect(split.preview).toEqual(items)
    expect(split.rest).toEqual([])
    expect(split.moreCount).toBe(0)
  })
})

describe('layoutMultiPrimaryPaletteSections', () => {
  it('puts trailing floor before leading rest so worktrees stay early', () => {
    const layout = layoutMultiPrimaryPaletteSections({
      leadingItems: range(12),
      trailingItems: range(5).map((n) => n + 100)
    })

    expect(layout.leadingPreview).toEqual(range(TYPED_QUERY_LEADING_PREVIEW))
    expect(layout.leadingMoreCount).toBe(6)
    expect(layout.trailingFloor).toEqual([100, 101, 102])
    expect(layout.trailingFloor).toHaveLength(TYPED_QUERY_TRAILING_FLOOR)
    expect(layout.trailingRest).toEqual([103, 104])
    expect(layout.leadingRest).toEqual([6, 7, 8, 9, 10, 11])
    expect(layout.trailingMoreCount).toBe(2)
    expect(layout.trailingHardOverflowCount).toBe(0)
  })

  it('shows all trailing rows in the floor when the section is small', () => {
    const layout = layoutMultiPrimaryPaletteSections({
      leadingItems: range(10),
      trailingItems: [200, 201]
    })

    expect(layout.trailingFloor).toEqual([200, 201])
    expect(layout.trailingRest).toEqual([])
    expect(layout.trailingMoreCount).toBe(0)
    expect(layout.trailingHardOverflowCount).toBe(0)
  })

  it('reports trailing hard-cap overflow without counting scrollable rest', () => {
    const layout = layoutMultiPrimaryPaletteSections({
      leadingItems: range(12),
      trailingItems: range(80).map((n) => n + 1000)
    })

    expect(layout.trailingFloor).toHaveLength(TYPED_QUERY_TRAILING_FLOOR)
    expect(layout.trailingRest).toHaveLength(
      PALETTE_SECTION_RENDER_CAP - TYPED_QUERY_TRAILING_FLOOR
    )
    expect(layout.trailingMoreCount).toBe(80 - TYPED_QUERY_TRAILING_FLOOR)
    expect(layout.trailingHardOverflowCount).toBe(80 - PALETTE_SECTION_RENDER_CAP)
  })
})

describe('orderMultiPrimaryPaletteItems', () => {
  it('interleaves floor before leading rest', () => {
    const layout = layoutMultiPrimaryPaletteSections({
      leadingItems: range(8),
      trailingItems: range(5).map((n) => n + 100)
    })

    expect(orderMultiPrimaryPaletteItems(layout)).toEqual([
      0, 1, 2, 3, 4, 5, 100, 101, 102, 6, 7, 103, 104
    ])
  })
})
