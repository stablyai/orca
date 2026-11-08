import { describe, expect, it } from 'vitest'
import {
  TAB_MAX_WIDTH,
  TAB_MIN_WIDTH,
  TAB_WIDTHS_MAX_ENTRIES,
  applyTabWidthChanges,
  normalizeTabWidthsById,
  withTabWidth
} from './tab-strip-width'

describe('normalizeTabWidthsById', () => {
  it('drops malformed entries and clamps out-of-range widths from hand-edited state', () => {
    expect(
      normalizeTabWidthsById({
        a: 200.4,
        tiny: 10,
        huge: 99_999,
        nan: Number.NaN,
        text: '300',
        '': 300,
        constructor: 300
      })
    ).toEqual({ a: 200, tiny: TAB_MIN_WIDTH, huge: TAB_MAX_WIDTH })
    expect(normalizeTabWidthsById(['a'])).toEqual({})
    expect(normalizeTabWidthsById(null)).toEqual({})
  })
})

describe('applyTabWidthChanges', () => {
  it('keeps disjoint resizes from clients that never saw each other', () => {
    const afterDesktop = applyTabWidthChanges({}, { desktop: 400 })
    // The web client's patch was computed before it heard about the desktop resize.
    const afterWeb = applyTabWidthChanges(afterDesktop, { web: 200 })

    expect(afterWeb).toEqual({ desktop: 400, web: 200 })
  })

  it('resets only the tabs a patch names and ignores malformed values', () => {
    expect(applyTabWidthChanges({ a: 200, b: 300 }, { a: null, c: 'wide', d: 250 })).toEqual({
      b: 300,
      d: 250
    })
    expect(applyTabWidthChanges({ a: 200 }, undefined)).toEqual({ a: 200 })
  })
})

describe('withTabWidth', () => {
  it('evicts the least recently resized tab once the map is full', () => {
    let widths: Record<string, number> = {}
    for (let i = 0; i < TAB_WIDTHS_MAX_ENTRIES; i++) {
      widths = withTabWidth(widths, `tab-${i}`, 200)
    }
    // Re-resizing tab-0 makes tab-1 the oldest.
    widths = withTabWidth(widths, 'tab-0', 250)
    widths = withTabWidth(widths, 'fresh', 300)

    expect(Object.keys(widths)).toHaveLength(TAB_WIDTHS_MAX_ENTRIES)
    expect(widths['tab-1']).toBeUndefined()
    expect(widths['tab-0']).toBe(250)
    expect(widths.fresh).toBe(300)
  })

  it('removes the entry when reset to the default width', () => {
    expect(withTabWidth({ a: 200, b: 300 }, 'a', null)).toEqual({ b: 300 })
  })
})
