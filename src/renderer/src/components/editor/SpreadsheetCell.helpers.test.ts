import { describe, expect, it } from 'vitest'
import {
  buildSpreadsheetCellBorderStyle,
  computeSpreadsheetIndentPx,
  resolveSpreadsheetCellAlignment
} from './SpreadsheetCell'

describe('resolveSpreadsheetCellAlignment', () => {
  it('prefers a declared centre over the value it would infer', () => {
    expect(
      resolveSpreadsheetCellAlignment('1234', {
        horizontalAlignment: 'center'
      })
    ).toBe('center')
  })

  it('keeps a declared left on a number', () => {
    expect(resolveSpreadsheetCellAlignment('42', { horizontalAlignment: 'left' })).toBe('left')
  })

  it('keeps a declared right on a label', () => {
    expect(
      resolveSpreadsheetCellAlignment('Total', {
        horizontalAlignment: 'right'
      })
    ).toBe('right')
  })

  it('infers left for free text without a style', () => {
    expect(resolveSpreadsheetCellAlignment('Presupuesto', undefined)).toBe('left')
  })

  it('infers left for an empty value without a style', () => {
    expect(resolveSpreadsheetCellAlignment('', undefined)).toBe('left')
  })

  it('does not infer left for a number', () => {
    expect(resolveSpreadsheetCellAlignment('-7.5', undefined)).not.toBe('left')
  })

  it('reports centre rather than right for a number', () => {
    expect(resolveSpreadsheetCellAlignment('1234', undefined)).toBe('center')
  })

  it('does not infer left for an ISO date, with or without a time', () => {
    expect(resolveSpreadsheetCellAlignment('2026-08-10', undefined)).not.toBe('left')
    expect(resolveSpreadsheetCellAlignment('2026-08-10T09:30', undefined)).not.toBe('left')
  })

  it('does not infer left for a time of day', () => {
    expect(resolveSpreadsheetCellAlignment('09:30:00', undefined)).not.toBe('left')
  })

  it('centres a boolean text', () => {
    expect(resolveSpreadsheetCellAlignment('TRUE', undefined)).toBe('center')
    expect(resolveSpreadsheetCellAlignment('FALSE', undefined)).toBe('center')
  })

  it('centres an error code', () => {
    expect(resolveSpreadsheetCellAlignment('#REF!', undefined)).toBe('center')
    expect(resolveSpreadsheetCellAlignment('#N/A', undefined)).toBe('center')
    expect(resolveSpreadsheetCellAlignment('#DIV/0!', undefined)).toBe('center')
  })

  it('infers from the value when the style only carries weight', () => {
    expect(resolveSpreadsheetCellAlignment('Gastos', { bold: true })).toBe('left')
    expect(resolveSpreadsheetCellAlignment('42', { bold: true })).toBe('center')
  })

  it('treats an explicitly undefined alignment as none at all', () => {
    expect(
      resolveSpreadsheetCellAlignment('Total', {
        horizontalAlignment: undefined
      })
    ).toBe('left')
    expect(resolveSpreadsheetCellAlignment('42', { horizontalAlignment: undefined })).toBe('center')
  })

  it('infers left for a number padded with spaces', () => {
    expect(resolveSpreadsheetCellAlignment(' 42 ', undefined)).toBe('left')
  })
})

describe('buildSpreadsheetCellBorderStyle', () => {
  it('returns no keys at all when the cell declares no borders', () => {
    expect(Object.keys(buildSpreadsheetCellBorderStyle(undefined))).toHaveLength(0)
  })

  it('returns all four edges undefined for an empty border record', () => {
    const style = buildSpreadsheetCellBorderStyle({})

    expect(Object.keys(style)).toHaveLength(4)
    expect(Object.values(style).every((value) => value === undefined)).toBe(true)
  })

  it('leaves the other three edges undefined when only the bottom is declared', () => {
    const style = buildSpreadsheetCellBorderStyle({
      bottom: { width: '2px', style: 'solid', color: '#ff0000' }
    })

    expect(style.borderBottom).toBe('2px solid #ff0000')
    expect(style.borderTop).toBeUndefined()
    expect(style.borderRight).toBeUndefined()
    expect(style.borderLeft).toBeUndefined()
  })

  it('falls back to currentColor when an edge declares no colour', () => {
    expect(
      buildSpreadsheetCellBorderStyle({ top: { width: '1px', style: 'solid' } }).borderTop
    ).toBe('1px solid currentColor')
  })

  it('maps each edge to its own CSS property', () => {
    const style = buildSpreadsheetCellBorderStyle({
      top: { width: '1px', style: 'solid', color: '#t' },
      right: { width: '2px', style: 'solid', color: '#r' },
      bottom: { width: '3px', style: 'solid', color: '#b' },
      left: { width: '4px', style: 'solid', color: '#l' }
    })

    expect(style.borderTop).toBe('1px solid #t')
    expect(style.borderRight).toBe('2px solid #r')
    expect(style.borderBottom).toBe('3px solid #b')
    expect(style.borderLeft).toBe('4px solid #l')
  })

  it('passes an unusual border style through untouched', () => {
    const style = buildSpreadsheetCellBorderStyle({
      top: { width: '3px', style: 'double' },
      right: { width: '1px', style: 'dotted' },
      bottom: { width: '1px', style: 'hair' }
    })

    expect(style.borderTop).toBe('3px double currentColor')
    expect(style.borderRight).toBe('1px dotted currentColor')
    expect(style.borderBottom).toBe('1px hair currentColor')
  })

  it('passes a width through without converting its unit', () => {
    expect(
      buildSpreadsheetCellBorderStyle({
        left: { width: 'thin', style: 'solid' }
      }).borderLeft
    ).toBe('thin solid currentColor')
    expect(
      buildSpreadsheetCellBorderStyle({
        left: { width: '0.5pt', style: 'solid' }
      }).borderLeft
    ).toBe('0.5pt solid currentColor')
  })

  it('only falls back to currentColor for a missing colour, not an empty one', () => {
    expect(
      buildSpreadsheetCellBorderStyle({
        bottom: { width: '1px', style: 'solid', color: '' }
      }).borderBottom
    ).toBe('1px solid ')
  })

  it('leaves the border record it was given untouched', () => {
    const borders = {
      bottom: { width: '2px', style: 'solid', color: '#ff0000' }
    }
    const snapshot = structuredClone(borders)

    buildSpreadsheetCellBorderStyle(borders)

    expect(borders).toEqual(snapshot)
  })
})

describe('computeSpreadsheetIndentPx', () => {
  it('reports no padding for a cell without an indent', () => {
    expect(computeSpreadsheetIndentPx(undefined, 13)).toBeUndefined()
  })

  it('reports no padding for a zero indent', () => {
    expect(computeSpreadsheetIndentPx(0, 13)).toBeUndefined()
  })

  it('reports no padding for a negative indent', () => {
    expect(computeSpreadsheetIndentPx(-2, 13)).toBeUndefined()
  })

  it('turns one indent level into three quarters of the font size', () => {
    expect(computeSpreadsheetIndentPx(1, 13)).toBe(10)
  })

  it('scales with the indent level', () => {
    expect(computeSpreadsheetIndentPx(3, 13)).toBe(29)
  })

  it('doubles when the reader doubles the font size', () => {
    expect(computeSpreadsheetIndentPx(1, 26)).toBe(computeSpreadsheetIndentPx(1, 13)! * 2)
  })

  it('clamps an absurd indent level to the deepest one a sheet allows', () => {
    expect(computeSpreadsheetIndentPx(400, 13)).toBe(computeSpreadsheetIndentPx(15, 13))
  })

  it('still grows up to the clamp', () => {
    expect(computeSpreadsheetIndentPx(14, 13)!).toBeLessThan(computeSpreadsheetIndentPx(15, 13)!)
  })

  it('rounds a fractional indent level', () => {
    expect(computeSpreadsheetIndentPx(2.5, 13)).toBe(24)
  })

  it('reports no padding for a NaN indent', () => {
    expect(computeSpreadsheetIndentPx(Number.NaN, 13)).toBeUndefined()
  })

  it('reports no padding for an infinite indent', () => {
    expect(computeSpreadsheetIndentPx(Number.POSITIVE_INFINITY, 13)).toBeUndefined()
    expect(computeSpreadsheetIndentPx(Number.NEGATIVE_INFINITY, 13)).toBeUndefined()
  })

  it('reports a whole number of pixels for a fractional font size', () => {
    expect(computeSpreadsheetIndentPx(3, 11.7)).toBe(26)
    expect(Number.isInteger(computeSpreadsheetIndentPx(3, 11.7))).toBe(true)
  })

  it('reports no padding rather than zero when the font size is zero', () => {
    expect(computeSpreadsheetIndentPx(2, 0)).toBeUndefined()
  })

  it('reports no padding for a negative font size', () => {
    expect(computeSpreadsheetIndentPx(2, -13)).toBeUndefined()
  })
})
