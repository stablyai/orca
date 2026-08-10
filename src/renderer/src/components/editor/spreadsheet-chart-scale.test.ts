import { describe, expect, it } from 'vitest'
import { buildSpreadsheetChartScale, projectOntoScale } from './spreadsheet-chart-scale'

describe('buildSpreadsheetChartScale', () => {
  it('puts ticks on round numbers', () => {
    expect(buildSpreadsheetChartScale([950, 1450, 1500], { includeZero: true })).toEqual({
      min: 0,
      max: 1500,
      ticks: [0, 500, 1000, 1500]
    })
    // A maximum that is not already on the step is rounded up to it.
    expect(buildSpreadsheetChartScale([950, 1600], { includeZero: true }).max).toBe(2000)
  })

  it('anchors a baseline form at zero so differences are not exaggerated', () => {
    // Why: a column chart drawn from 900 to 1000 makes a 10% gap look total. That
    // is the classic way a chart lies about its own data.
    expect(buildSpreadsheetChartScale([950, 1000], { includeZero: true }).min).toBe(0)
  })

  it('lets a line frame its own range', () => {
    const scale = buildSpreadsheetChartScale([950, 1000], { includeZero: false })

    expect(scale.min).toBeGreaterThan(0)
    expect(scale.min).toBeLessThanOrEqual(950)
    expect(scale.max).toBeGreaterThanOrEqual(1000)
  })

  it('covers negative values on both sides of zero', () => {
    const scale = buildSpreadsheetChartScale([-50, 120], { includeZero: true })

    expect(scale.min).toBeLessThanOrEqual(-50)
    expect(scale.max).toBeGreaterThanOrEqual(120)
    expect(scale.ticks).toContain(0)
  })

  it('gives a flat series a band to draw in', () => {
    const scale = buildSpreadsheetChartScale([5, 5, 5], { includeZero: false })

    expect(scale.max).toBeGreaterThan(scale.min)
  })

  it('handles an all-zero series without dividing by zero', () => {
    const scale = buildSpreadsheetChartScale([0, 0], { includeZero: true })

    expect(scale.max).toBeGreaterThan(scale.min)
    expect(Number.isFinite(projectOntoScale(0, scale))).toBe(true)
  })

  it('ignores gaps and non-finite values', () => {
    expect(buildSpreadsheetChartScale([null, 10, null], { includeZero: true }).max).toBe(10)
    expect(buildSpreadsheetChartScale([], { includeZero: true })).toEqual({
      min: 0,
      max: 1,
      ticks: [0, 1]
    })
  })

  it('does not drift on a fractional step', () => {
    const scale = buildSpreadsheetChartScale([0, 0.7], { includeZero: true })

    for (const tick of scale.ticks) {
      expect(Number(tick.toFixed(10))).toBe(tick)
    }
  })

  it('scales very large and very small ranges onto round ticks', () => {
    expect(buildSpreadsheetChartScale([0, 8_400_000], { includeZero: true }).max % 1).toBe(0)
    expect(
      buildSpreadsheetChartScale([0, 0.004], { includeZero: true }).ticks.length
    ).toBeGreaterThan(2)
  })
})

describe('projectOntoScale', () => {
  it('maps the ends of the scale to 0 and 1', () => {
    const scale = { min: 0, max: 2000, ticks: [] }

    expect(projectOntoScale(0, scale)).toBe(0)
    expect(projectOntoScale(2000, scale)).toBe(1)
    expect(projectOntoScale(1000, scale)).toBe(0.5)
  })

  it('does not divide by zero on a degenerate scale', () => {
    expect(projectOntoScale(5, { min: 5, max: 5, ticks: [] })).toBe(0)
  })
})
