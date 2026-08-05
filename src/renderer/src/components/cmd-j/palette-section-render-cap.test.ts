import { describe, expect, it } from 'vitest'
import { capPaletteSection, PALETTE_SECTION_RENDER_CAP } from './palette-section-render-cap'

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
