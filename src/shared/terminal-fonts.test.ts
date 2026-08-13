import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_FONT_WEIGHT,
  clusterTerminalFontFaces,
  resolveTerminalFontWeights,
  normalizeTerminalFontWeight
} from './terminal-fonts'

describe('terminal font weights', () => {
  it('falls back to the Orca default when the value is missing', () => {
    expect(normalizeTerminalFontWeight(undefined)).toBe(DEFAULT_TERMINAL_FONT_WEIGHT)
  })

  it('clamps weights to the supported xterm range', () => {
    expect(normalizeTerminalFontWeight(10)).toBe(100)
    expect(normalizeTerminalFontWeight(1200)).toBe(900)
  })

  it('keeps bold text heavier than the base terminal weight', () => {
    expect(resolveTerminalFontWeights(500)).toEqual({
      fontWeight: 500,
      fontWeightBold: 700
    })
  })

  it('does not collapse regular and bold when the slider is already 600+', () => {
    expect(resolveTerminalFontWeights(600)).toEqual({
      fontWeight: 400,
      fontWeightBold: 700
    })
    expect(resolveTerminalFontWeights(700)).toEqual({
      fontWeight: 400,
      fontWeightBold: 700
    })
    expect(resolveTerminalFontWeights(800)).toEqual({
      fontWeight: 400,
      fontWeightBold: 700
    })
    expect(resolveTerminalFontWeights(900)).toEqual({
      fontWeight: 400,
      fontWeightBold: 700
    })
  })

  it('maps a two-face family so a requested bold weight still has a lighter regular', () => {
    expect(resolveTerminalFontWeights(600, [400, 700])).toEqual({
      fontWeight: 400,
      fontWeightBold: 700
    })
    expect(resolveTerminalFontWeights(700, [400, 700])).toEqual({
      fontWeight: 400,
      fontWeightBold: 700
    })
    expect(resolveTerminalFontWeights(900, [400, 700])).toEqual({
      fontWeight: 400,
      fontWeightBold: 700
    })
  })

  it('keeps a multi-face family at the requested weight when a heavier bold exists', () => {
    const jetbrainsFaces = [100, 200, 300, 400, 500, 600, 700, 800]
    expect(resolveTerminalFontWeights(500, jetbrainsFaces)).toEqual({
      fontWeight: 500,
      fontWeightBold: 700
    })
    expect(resolveTerminalFontWeights(600, jetbrainsFaces)).toEqual({
      fontWeight: 600,
      fontWeightBold: 800
    })
    expect(resolveTerminalFontWeights(800, jetbrainsFaces)).toEqual({
      fontWeight: 700,
      fontWeightBold: 800
    })
  })
})

describe('clusterTerminalFontFaces', () => {
  it('reduces the measured two-state Menlo raster to regular and bold anchors', () => {
    const regular = { ink: 3023, sum: 684988, advance: 354.0059 }
    const bold = { ink: 3855, sum: 903760, advance: 354.0059 }
    const faces = clusterTerminalFontFaces(
      [300, 400, 500, 600, 700, 800, 900].map((weight) => ({
        weight,
        ...(weight < 600 ? regular : bold)
      }))
    )

    expect(faces).toEqual([400, 700])
    expect(resolveTerminalFontWeights(600, faces)).toEqual({
      fontWeight: 400,
      fontWeightBold: 700
    })
    expect(resolveTerminalFontWeights(700, faces).fontWeight).not.toBe(
      resolveTerminalFontWeights(700, faces).fontWeightBold
    )
  })
})
