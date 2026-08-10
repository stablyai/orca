import { describe, expect, it } from 'vitest'
import { parseXlsxCellFormats } from './xlsx-cell-formats'

describe('parseXlsxCellFormats', () => {
  it('reads the number format, font and fill of each cell format in order', () => {
    const cellFormats = parseXlsxCellFormats(
      '<styleSheet><cellXfs count="2"><xf numFmtId="164" fontId="3" fillId="2"/><xf numFmtId="0" fontId="0" fillId="0"/></cellXfs></styleSheet>'
    )

    expect(cellFormats).toEqual([
      { numberFormatId: 164, fontId: 3, fillId: 2 },
      { numberFormatId: 0, fontId: 0, fillId: 0 }
    ])
  })

  it('defaults each missing or invalid id instead of dropping the entry', () => {
    // Why: index alignment with a cell's `s` attribute matters more than the ids;
    // dropping an entry would shift every later style by one.
    const cellFormats = parseXlsxCellFormats(
      '<styleSheet><cellXfs count="2"><xf/><xf numFmtId="x" fontId="-1" fillId="2"/></cellXfs></styleSheet>'
    )

    expect(cellFormats).toEqual([
      { numberFormatId: 0, fontId: 0, fillId: 0 },
      { numberFormatId: 0, fontId: 0, fillId: 2 }
    ])
  })

  it('reads cellXfs and not cellStyleXfs', () => {
    const cellFormats = parseXlsxCellFormats(
      '<styleSheet><cellStyleXfs count="1"><xf numFmtId="14" fillId="9"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fillId="0"/></cellXfs></styleSheet>'
    )

    expect(cellFormats).toEqual([{ numberFormatId: 0, fontId: 0, fillId: 0 }])
  })

  it('returns nothing for a missing styles part', () => {
    expect(parseXlsxCellFormats('')).toEqual([])
    expect(parseXlsxCellFormats('<styleSheet/>')).toEqual([])
  })
})
