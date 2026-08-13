import { describe, expect, it } from 'vitest'
import { computeSpreadsheetAutoRowHeight } from './spreadsheet-row-heights'
import type { SpreadsheetCellStyle } from './SpreadsheetCell'

const BASE_ROW_HEIGHT_PX = 28
const FONT_SIZE_PX = 13

function scaled(...scales: readonly (number | undefined)[]): (SpreadsheetCellStyle | undefined)[] {
  return scales.map((fontScale) => (fontScale === undefined ? undefined : { fontScale }))
}

function heightOf(
  rowStyles: readonly (SpreadsheetCellStyle | undefined)[] | undefined,
  overrides: { baseRowHeightPx?: number; fontSizePx?: number } = {}
): number {
  return computeSpreadsheetAutoRowHeight({
    rowStyles,
    baseRowHeightPx: overrides.baseRowHeightPx ?? BASE_ROW_HEIGHT_PX,
    fontSizePx: overrides.fontSizePx ?? FONT_SIZE_PX
  })
}

describe('computeSpreadsheetAutoRowHeight', () => {
  it('falls back to the base height for a row the sheet has no styles for', () => {
    expect(heightOf(undefined)).toBe(BASE_ROW_HEIGHT_PX)
  })

  it('keeps the base height for a row whose cells set no font size', () => {
    expect(heightOf([{}, { bold: true }, {}])).toBe(BASE_ROW_HEIGHT_PX)
  })

  it('keeps the base height for a row at the file default font size', () => {
    expect(heightOf(scaled(1, 1))).toBe(BASE_ROW_HEIGHT_PX)
  })

  it('does not shrink a row for a font smaller than the default', () => {
    expect(heightOf(scaled(0.5))).toBe(BASE_ROW_HEIGHT_PX)
  })

  it('grows the row to fit a font at twice the default size', () => {
    expect(heightOf(scaled(2))).toBe(39)
  })

  it('fits the largest font in the row rather than the first or the last', () => {
    expect(heightOf(scaled(1, 2.5, 1.2))).toBe(47)
  })

  it('measures a row whose cells are only partly styled', () => {
    expect(heightOf(scaled(undefined, 2.5, undefined))).toBe(47)
  })

  it('never returns less than the base height even when the text fits in it', () => {
    expect(heightOf(scaled(1.2), { baseRowHeightPx: 60 })).toBe(60)
  })

  it('caps an absurd font size so it cannot hide every row below it', () => {
    expect(heightOf(scaled(100))).toBe(400)
  })

  it('asks for more height at a larger rendered font size', () => {
    expect(heightOf(scaled(2), { fontSizePx: 26 })).toBeGreaterThan(heightOf(scaled(2)))
  })

  it('returns a whole number of pixels for a fractional font scale', () => {
    expect(Number.isInteger(heightOf(scaled(1.37)))).toBe(true)
  })

  it('gives a title row more room than the body rows around it', () => {
    const titleRow = heightOf(scaled(2.5, 1))
    const bodyRow = heightOf(scaled(1, 1))

    expect(titleRow).toBe(47)
    expect(bodyRow).toBe(BASE_ROW_HEIGHT_PX)
    expect(titleRow).toBeGreaterThan(bodyRow)
  })
})
