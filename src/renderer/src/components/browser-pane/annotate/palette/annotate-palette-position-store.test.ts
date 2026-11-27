import { describe, expect, it } from 'vitest'
import { parseAnnotatePalettePosition } from './annotate-palette-position-store'

describe('annotate palette saved position', () => {
  it('reads back both axes', () => {
    expect(parseAnnotatePalettePosition(JSON.stringify({ x: 0.2, y: 0.9 }))).toEqual({
      x: 0.2,
      y: 0.9
    })
  })

  it('reads an earlier horizontal-only position as that place at the top', () => {
    expect(parseAnnotatePalettePosition('0.25')).toEqual({ x: 0.25, y: 0 })
  })

  it('falls back to bottom centre for missing, damaged or out-of-range values', () => {
    expect(parseAnnotatePalettePosition(null)).toEqual({ x: 0.5, y: 1 })
    expect(parseAnnotatePalettePosition('{not json')).toEqual({ x: 0.5, y: 1 })
    expect(parseAnnotatePalettePosition('{"x":"left"}')).toEqual({ x: 0.5, y: 1 })
    expect(parseAnnotatePalettePosition('{"x":-3,"y":7}')).toEqual({ x: 0, y: 1 })
  })
})
