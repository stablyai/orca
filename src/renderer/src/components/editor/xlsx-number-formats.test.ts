import { describe, expect, it } from 'vitest'
import { isXlsxDateFormatCode, parseXlsxNumberFormats } from './xlsx-number-formats'

function stylesWithCellFormats(numberFormatIds: number[], numberFormatsXml = ''): string {
  const cellFormats = numberFormatIds
    .map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0"/>`)
    .join('')
  return `<styleSheet>${numberFormatsXml}<cellStyleXfs count="1"><xf numFmtId="99"/></cellStyleXfs><cellXfs count="${numberFormatIds.length}">${cellFormats}</cellXfs></styleSheet>`
}

describe('parseXlsxNumberFormats', () => {
  it('recognizes built-in date and time formats by id', () => {
    const numberFormats = parseXlsxNumberFormats(stylesWithCellFormats([0, 14, 22, 47]))

    expect(numberFormats.isDateStyle(0)).toBe(false)
    expect(numberFormats.isDateStyle(1)).toBe(true)
    expect(numberFormats.isDateStyle(2)).toBe(true)
    expect(numberFormats.isDateStyle(3)).toBe(true)
  })

  it('treats built-in numeric and currency formats as non-dates', () => {
    const numberFormats = parseXlsxNumberFormats(stylesWithCellFormats([1, 4, 9, 10, 37, 44]))

    for (let styleIndex = 0; styleIndex < 6; styleIndex += 1) {
      expect(numberFormats.isDateStyle(styleIndex)).toBe(false)
    }
  })

  it('recognizes a custom date format by its format code', () => {
    const numberFormats = parseXlsxNumberFormats(
      stylesWithCellFormats(
        [164],
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts>'
      )
    )

    expect(numberFormats.isDateStyle(0)).toBe(true)
  })

  it('does not treat a custom numeric format as a date', () => {
    const numberFormats = parseXlsxNumberFormats(
      stylesWithCellFormats(
        [165],
        '<numFmts count="1"><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>'
      )
    )

    expect(numberFormats.isDateStyle(0)).toBe(false)
  })

  it('lets a custom format code override a built-in date id', () => {
    // Why: producers do reassign ids in the built-in range. The declared code has
    // to win, or a plain number would be rendered as a date.
    const numberFormats = parseXlsxNumberFormats(
      stylesWithCellFormats(
        [14],
        '<numFmts count="1"><numFmt numFmtId="14" formatCode="0.000"/></numFmts>'
      )
    )

    expect(numberFormats.isDateStyle(0)).toBe(false)
  })

  it('indexes cellXfs and not cellStyleXfs', () => {
    // Why: a cell's `s` attribute indexes cellXfs. Reading cellStyleXfs instead
    // would silently apply another format's id to every cell.
    const numberFormats = parseXlsxNumberFormats(
      `<styleSheet><cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`
    )

    expect(numberFormats.isDateStyle(0)).toBe(false)
  })

  it('treats an unknown style index and an absent style as non-dates', () => {
    const numberFormats = parseXlsxNumberFormats(stylesWithCellFormats([14]))

    expect(numberFormats.isDateStyle(undefined)).toBe(false)
    expect(numberFormats.isDateStyle(7)).toBe(false)
    expect(numberFormats.isDateStyle(-1)).toBe(false)
  })

  it('treats a missing styles part as having no date styles', () => {
    const numberFormats = parseXlsxNumberFormats('')

    expect(numberFormats.isDateStyle(0)).toBe(false)
  })

  it('defaults a cell format with no numFmtId to General', () => {
    const numberFormats = parseXlsxNumberFormats(
      '<styleSheet><cellXfs count="2"><xf fontId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
    )

    expect(numberFormats.isDateStyle(0)).toBe(false)
    expect(numberFormats.isDateStyle(1)).toBe(true)
  })
})

describe('isXlsxDateFormatCode', () => {
  it('accepts date and time codes', () => {
    expect(isXlsxDateFormatCode('yyyy-mm-dd')).toBe(true)
    expect(isXlsxDateFormatCode('d/m/yy')).toBe(true)
    expect(isXlsxDateFormatCode('[$-409]h:mm:ss AM/PM')).toBe(true)
    expect(isXlsxDateFormatCode('[h]:mm:ss')).toBe(true)
  })

  it('rejects numeric codes', () => {
    expect(isXlsxDateFormatCode('General')).toBe(false)
    expect(isXlsxDateFormatCode('0.00')).toBe(false)
    expect(isXlsxDateFormatCode('#,##0.00;[Red]-#,##0.00')).toBe(false)
    expect(isXlsxDateFormatCode('0.00%')).toBe(false)
  })

  it('ignores date letters that only appear inside literals', () => {
    expect(isXlsxDateFormatCode('0.00" days"')).toBe(false)
    expect(isXlsxDateFormatCode('#,##0" m"')).toBe(false)
    expect(isXlsxDateFormatCode('0\\d')).toBe(false)
    expect(isXlsxDateFormatCode('_-* #,##0.00_-;_-* "-"??_-')).toBe(false)
  })

  it('ignores the locale and colour sections around a numeric code', () => {
    expect(isXlsxDateFormatCode('[$$-409]#,##0.00')).toBe(false)
    expect(isXlsxDateFormatCode('[Red]0.00')).toBe(false)
  })
})
