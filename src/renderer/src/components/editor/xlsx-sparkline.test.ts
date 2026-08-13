import { describe, expect, it } from 'vitest'
import { parseXlsxSparklineFormula, resolveXlsxSparkline } from './xlsx-sparkline'

// The exact formulas a Google Sheets export leaves in the file, with the doubled
// quotes that escaping inside DUMMYFUNCTION produces.
const COLUMN_FORMULA =
  'IFERROR(__xludf.DUMMYFUNCTION("SPARKLINE(D17,{""charttype"",""column"";""ymin"", 0; ""ymax"",MAX(D17:E17);""firstcolor"",""#334960""})"),"")'
const BAR_FORMULA =
  'IFERROR(__xludf.DUMMYFUNCTION("SPARKLINE(C21,{""charttype"",""bar"";""max"",max(C21:C22);""color1"",""#AEB7C0""})"),"")'

describe('parseXlsxSparklineFormula', () => {
  it('reads the chart type, reference and options out of an exported formula', () => {
    expect(parseXlsxSparklineFormula(COLUMN_FORMULA)).toEqual({
      chartType: 'column',
      dataReference: 'D17',
      options: {
        charttype: 'column',
        ymin: '0',
        ymax: 'MAX(D17:E17)',
        firstcolor: '#334960'
      }
    })
  })

  it('reads a bar sparkline over a range', () => {
    const spec = parseXlsxSparklineFormula(BAR_FORMULA)

    expect(spec?.chartType).toBe('bar')
    expect(spec?.dataReference).toBe('C21')
    expect(spec?.options.color1).toBe('#AEB7C0')
    expect(spec?.options.max).toBe('max(C21:C22)')
  })

  it('reads a call written directly, without the export wrapper', () => {
    const spec = parseXlsxSparklineFormula('SPARKLINE(A1:A9,{"charttype","line";"color","#f00"})')

    expect(spec).toEqual({
      chartType: 'line',
      dataReference: 'A1:A9',
      options: { charttype: 'line', color: '#f00' }
    })
  })

  it('defaults to a line when no chart type is given', () => {
    expect(parseXlsxSparklineFormula('SPARKLINE(A1:A9)')?.chartType).toBe('line')
    expect(parseXlsxSparklineFormula('SPARKLINE(A1:A9)')?.dataReference).toBe('A1:A9')
  })

  it('falls back to a line for a chart type it does not know', () => {
    expect(parseXlsxSparklineFormula('SPARKLINE(A1,{"charttype","pie"})')?.chartType).toBe('line')
  })

  it('returns null for a formula with no sparkline', () => {
    expect(parseXlsxSparklineFormula('SUM(A1:A9)')).toBeNull()
    expect(parseXlsxSparklineFormula('')).toBeNull()
  })

  it('returns null for an unbalanced call rather than reading past it', () => {
    expect(parseXlsxSparklineFormula('SPARKLINE(A1,{"charttype","bar"}')).toBeNull()
  })

  it('is not confused by a comma inside a nested function or option block', () => {
    const spec = parseXlsxSparklineFormula(
      'SPARKLINE(OFFSET(A1,0,1),{"charttype","column";"ymax",MAX(B1:B9)})'
    )

    expect(spec?.dataReference).toBe('OFFSET(A1,0,1)')
    expect(spec?.options.ymax).toBe('MAX(B1:B9)')
  })
})

describe('resolveXlsxSparkline', () => {
  const values: Record<string, number[]> = {
    D17: [1000],
    'D17:E17': [1000, 1500],
    C21: [950],
    'C21:C22': [950, 1000]
  }
  const readRange = (reference: string): number[] => values[reference] ?? []

  it('pins the scale with the MAX over a range, so siblings share it', () => {
    // Why: the two balance columns are separate sparklines; without the shared
    // ymax each would fill its own cell and the comparison would be lost.
    const resolved = resolveXlsxSparkline(parseXlsxSparklineFormula(COLUMN_FORMULA)!, readRange)

    expect(resolved).toMatchObject({ chartType: 'column', values: [1000], min: 0, max: 1500 })
  })

  it('takes the colour the author set', () => {
    expect(resolveXlsxSparkline(parseXlsxSparklineFormula(COLUMN_FORMULA)!, readRange)?.color).toBe(
      '#334960'
    )
    expect(resolveXlsxSparkline(parseXlsxSparklineFormula(BAR_FORMULA)!, readRange)?.color).toBe(
      '#AEB7C0'
    )
  })

  it('reads a literal bound as well as a function', () => {
    const spec = parseXlsxSparklineFormula('SPARKLINE(D17,{"charttype","column";"ymax",2000})')!

    expect(resolveXlsxSparkline(spec, readRange)?.max).toBe(2000)
  })

  it('falls back to the data bounds for an option it cannot evaluate', () => {
    const spec = parseXlsxSparklineFormula(
      'SPARKLINE(D17:E17,{"charttype","column";"ymax",VLOOKUP(A1,B:C,2)})'
    )!

    expect(resolveXlsxSparkline(spec, readRange)?.max).toBe(1500)
  })

  it('returns null when the reference resolves to nothing', () => {
    const spec = parseXlsxSparklineFormula('SPARKLINE(ZZ99,{"charttype","bar"})')!

    expect(resolveXlsxSparkline(spec, readRange)).toBeNull()
  })
})
