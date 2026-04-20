import { describe, expect, it } from 'vitest'
import {
  clampMermaidZoom,
  continuousMermaidZoom,
  fitMermaidZoom,
  getMermaidSvgBaseSize,
  MERMAID_ZOOM_MAX,
  MERMAID_ZOOM_MIN,
  MERMAID_ZOOM_STEP,
  nudgeMermaidZoom
} from './mermaid-zoom'

describe('clampMermaidZoom', () => {
  it('keeps zoom within the supported range', () => {
    expect(clampMermaidZoom(MERMAID_ZOOM_MIN - 1)).toBe(MERMAID_ZOOM_MIN)
    expect(clampMermaidZoom(MERMAID_ZOOM_MAX + 1)).toBe(MERMAID_ZOOM_MAX)
  })

  it('falls back to 100% for non-finite values', () => {
    expect(clampMermaidZoom(Number.NaN)).toBe(1)
  })
})

describe('nudgeMermaidZoom', () => {
  it('steps zoom in both directions', () => {
    expect(nudgeMermaidZoom(1, 1)).toBe(1 + MERMAID_ZOOM_STEP)
    expect(nudgeMermaidZoom(1, -1)).toBe(1 - MERMAID_ZOOM_STEP)
  })

  it('clamps nudges at the bounds', () => {
    expect(nudgeMermaidZoom(MERMAID_ZOOM_MAX, 1)).toBe(MERMAID_ZOOM_MAX)
    expect(nudgeMermaidZoom(MERMAID_ZOOM_MIN, -1)).toBe(MERMAID_ZOOM_MIN)
  })
})

describe('continuousMermaidZoom', () => {
  it('zooms in on negative deltaY and out on positive deltaY', () => {
    expect(continuousMermaidZoom(1, -100)).toBeGreaterThan(1)
    expect(continuousMermaidZoom(1, 100)).toBeLessThan(1)
  })

  it('clamps within the supported range', () => {
    expect(continuousMermaidZoom(MERMAID_ZOOM_MAX, -10_000)).toBe(MERMAID_ZOOM_MAX)
    expect(continuousMermaidZoom(MERMAID_ZOOM_MIN, 10_000)).toBe(MERMAID_ZOOM_MIN)
  })
})

describe('fitMermaidZoom', () => {
  it('computes the largest scale that fits both dimensions with padding', () => {
    const result = fitMermaidZoom({
      svgWidth: 800,
      svgHeight: 600,
      viewportWidth: 432,
      viewportHeight: 332,
      padding: 16
    })
    // width-fit = (432-32)/800 = 0.5, height-fit = (332-32)/600 = 0.5
    expect(result).toBeCloseTo(0.5, 5)
  })

  it('uses width-only fit when svg height is missing', () => {
    const result = fitMermaidZoom({
      svgWidth: 800,
      svgHeight: null,
      viewportWidth: 432,
      viewportHeight: 100,
      padding: 16
    })
    expect(result).toBeCloseTo(0.5, 5)
  })

  it('returns 1 when the svg has no width', () => {
    expect(
      fitMermaidZoom({
        svgWidth: 0,
        svgHeight: 100,
        viewportWidth: 400,
        viewportHeight: 400
      })
    ).toBe(1)
  })

  it('clamps the result to the supported range', () => {
    const tiny = fitMermaidZoom({
      svgWidth: 10,
      svgHeight: 10,
      viewportWidth: 10_000,
      viewportHeight: 10_000
    })
    expect(tiny).toBe(MERMAID_ZOOM_MAX)
  })
})

describe('getMermaidSvgBaseSize', () => {
  it('prefers explicit svg dimensions when present', () => {
    expect(
      getMermaidSvgBaseSize({
        width: '640',
        height: '512px',
        viewBox: '0 0 100 80'
      })
    ).toEqual({ width: 640, height: 512 })
  })

  it('falls back to the viewBox when width is missing', () => {
    expect(
      getMermaidSvgBaseSize({
        width: null,
        height: null,
        viewBox: '0 0 320 240'
      })
    ).toEqual({ width: 320, height: 240 })
  })

  it('falls back to the viewBox when svg dimensions are percentages', () => {
    expect(
      getMermaidSvgBaseSize({
        width: '100%',
        height: '100%',
        viewBox: '0 0 320 240'
      })
    ).toEqual({ width: 320, height: 240 })
  })

  it('returns null when neither dimensions nor a valid viewBox exist', () => {
    expect(
      getMermaidSvgBaseSize({
        width: 'auto',
        height: null,
        viewBox: 'invalid'
      })
    ).toBeNull()
  })
})
