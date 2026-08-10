import { describe, expect, it } from 'vitest'
import {
  getSpreadsheetCellAlignment,
  getSpreadsheetCellAlignmentClass
} from './spreadsheet-cell-alignment'

describe('getSpreadsheetCellAlignment', () => {
  it('right-aligns numbers in every form a cell stores them', () => {
    for (const value of ['0', '42', '-7', '+7', '1250.5', '0.30000000000000004', '1E+21', '.5']) {
      expect(getSpreadsheetCellAlignment(value)).toBe('right')
    }
  })

  it('right-aligns a comma decimal separator and a percentage', () => {
    expect(getSpreadsheetCellAlignment('1250,5')).toBe('right')
    expect(getSpreadsheetCellAlignment('12%')).toBe('right')
  })

  it('right-aligns dates and times, as a spreadsheet does', () => {
    for (const value of [
      '2025-01-01',
      '2025-01-01 12:00:00',
      '2025-01-01T12:30',
      '2026-07-06',
      '18:01:00'
    ]) {
      expect(getSpreadsheetCellAlignment(value)).toBe('right')
    }
  })

  it('centers booleans and cached error codes', () => {
    expect(getSpreadsheetCellAlignment('TRUE')).toBe('center')
    expect(getSpreadsheetCellAlignment('FALSE')).toBe('center')
    expect(getSpreadsheetCellAlignment('#DIV/0!')).toBe('center')
    expect(getSpreadsheetCellAlignment('#N/A')).toBe('center')
    expect(getSpreadsheetCellAlignment('#REF!')).toBe('center')
  })

  it('left-aligns text, including text that merely contains digits', () => {
    for (const value of [
      'Region',
      'MD_Monobloc_MD_10',
      '150 m²',
      '2347.93 €',
      'Sí (350 €)',
      '4 dormitorios',
      'true',
      '#hashtag'
    ]) {
      expect(getSpreadsheetCellAlignment(value)).toBe('left')
    }
  })

  it('left-aligns an empty cell so padding does not shift the grid', () => {
    expect(getSpreadsheetCellAlignment('')).toBe('left')
  })
})

describe('getSpreadsheetCellAlignmentClass', () => {
  it('maps each alignment to matching flex and text utilities', () => {
    expect(getSpreadsheetCellAlignmentClass('42')).toBe('justify-end text-right')
    expect(getSpreadsheetCellAlignmentClass('TRUE')).toBe('justify-center text-center')
    expect(getSpreadsheetCellAlignmentClass('Region')).toBe('justify-start text-left')
  })
})
