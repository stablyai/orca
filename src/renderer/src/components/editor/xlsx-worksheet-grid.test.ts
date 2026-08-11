import { describe, expect, it } from 'vitest'
import { parseXlsxCellStyles } from './xlsx-cell-styles'
import { parseXlsxNumberFormats } from './xlsx-number-formats'
import { parseXlsxWorksheetGrid, type XlsxWorksheetContext } from './xlsx-worksheet-grid'

function context(overrides: Partial<XlsxWorksheetContext> = {}): XlsxWorksheetContext {
  return {
    sharedStrings: [],
    numberFormats: parseXlsxNumberFormats(''),
    cellStyles: parseXlsxCellStyles('', []),
    use1904DateSystem: false,
    maxRows: 1000,
    locale: 'en-US',
    ...overrides
  }
}

const FILL_STYLES_XML =
  '<styleSheet><fonts count="1"><font/></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><cellXfs count="2"><xf fontId="0" fillId="0"/><xf fontId="0" fillId="1"/></cellXfs></styleSheet>'

const DATE_STYLES = parseXlsxNumberFormats(
  '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
)

describe('parseXlsxWorksheetGrid cell styles', () => {
  it('emits a style per cell, positionally matching the rows', () => {
    const xml =
      '<row r="1"><c r="A1" s="1" t="str"><v>filled</v></c><c r="B1" s="0" t="str"><v>plain</v></c></row>'

    const grid = parseXlsxWorksheetGrid(
      xml,
      context({ cellStyles: parseXlsxCellStyles(FILL_STYLES_XML, []) })
    )

    expect(grid.rows).toEqual([['filled', 'plain']])
    expect(grid.styles[0]?.[0]).toEqual({ backgroundColor: '#ffff00', textColor: '#000000' })
    expect(grid.styles[0]?.[1]).toBeUndefined()
  })

  it('leaves the style matrix empty when the workbook declares no styling', () => {
    // Why: an unstyled sheet must not pay for a parallel matrix of undefined.
    const grid = parseXlsxWorksheetGrid('<row r="1"><c r="A1"><v>1</v></c></row>', context())

    expect(grid.styles).toEqual([])
  })

  it('keeps the style matrix as tall as the row matrix across skipped rows', () => {
    const xml =
      '<row r="1"><c r="A1" s="1" t="str"><v>a</v></c></row><row r="3"><c r="A3" s="1" t="str"><v>b</v></c></row>'

    const grid = parseXlsxWorksheetGrid(
      xml,
      context({ cellStyles: parseXlsxCellStyles(FILL_STYLES_XML, []) })
    )

    expect(grid.rows).toHaveLength(3)
    expect(grid.styles).toHaveLength(3)
    expect(grid.styles[1]).toEqual([])
    expect(grid.styles[2]?.[0]?.backgroundColor).toBe('#ffff00')
  })

  it('reuses one style object across every cell that shares a style index', () => {
    const xml =
      '<row r="1"><c r="A1" s="1" t="str"><v>a</v></c><c r="B1" s="1" t="str"><v>b</v></c></row>'

    const grid = parseXlsxWorksheetGrid(
      xml,
      context({ cellStyles: parseXlsxCellStyles(FILL_STYLES_XML, []) })
    )

    expect(grid.styles[0]?.[0]).toBe(grid.styles[0]?.[1])
  })
})

describe('parseXlsxWorksheetGrid', () => {
  it('reads numbers, shared strings and inline strings into a dense grid', () => {
    const xml = `<sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2"><v>42</v></c><c r="B2" t="inlineStr"><is><t>inline</t></is></c></row>
    </sheetData>`

    const grid = parseXlsxWorksheetGrid(xml, context({ sharedStrings: ['Name', 'Qty'] }))

    expect(grid.rows).toEqual([
      ['Name', 'Qty'],
      ['42', 'inline']
    ])
    expect(grid.maxColumns).toBe(2)
    expect(grid.truncated).toBe(false)
  })

  it('pads skipped rows so values stay on their own row', () => {
    const xml = '<row r="1"><c r="A1"><v>1</v></c></row><row r="4"><c r="A4"><v>4</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['1'], [''], [''], ['4']])
  })

  it('pads skipped columns so values stay under their own column', () => {
    const xml = '<row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['1', '', '', '4']])
    expect(grid.maxColumns).toBe(4)
  })

  it('pads short rows out to the widest row', () => {
    const xml =
      '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="C2"><v>3</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([
      ['1', '', ''],
      ['2', '', '3']
    ])
  })

  it('falls back to positional indexes when cells carry no reference', () => {
    const xml = '<row><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([
      ['1', '2'],
      ['3', '']
    ])
  })

  it('ignores an unparseable cell reference rather than dropping the value', () => {
    const xml = '<row r="1"><c r="A1"><v>1</v></c><c r="not-a-ref"><v>2</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['1', '2']])
  })

  it('does not allocate a row for a column reference past the Excel grid', () => {
    // Why: the padding loop runs up to the parsed column index, so a short but
    // huge reference must be rejected before it can drive a giant allocation.
    const xml = '<row r="1"><c r="A1"><v>1</v></c><c r="AAAAAAAA1"><v>2</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.maxColumns).toBe(2)
    expect(grid.rows).toEqual([['1', '2']])
  })

  it('drops phonetic runs from an inline string, like a shared string', () => {
    // Why: the same Japanese value must not render differently depending on
    // whether the producer stored it inline or in the shared string table.
    const xml =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>課税</t><rPh sb="0" eb="2"><t>カゼイ</t></rPh></is></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['課税']])
  })

  it('renders booleans and cached errors as their display text', () => {
    const xml =
      '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="e"><v>#DIV/0!</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['TRUE', 'FALSE', '#DIV/0!']])
  })

  it('renders a cached formula result and ignores the formula itself', () => {
    const xml = '<row r="1"><c r="A1" t="str"><f>CONCAT(B1,C1)</f><v>ab</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['ab']])
  })

  it('renders an ISO date cell verbatim', () => {
    const xml = '<row r="1"><c r="A1" t="d"><v>2025-01-01T12:30:00</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['2025-01-01T12:30:00']])
  })

  it('renders a date-styled number as a date and leaves other numbers alone', () => {
    const xml = '<row r="1"><c r="A1" s="1"><v>45658</v></c><c r="B1" s="0"><v>45658</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context({ numberFormats: DATE_STYLES }))

    expect(grid.rows).toEqual([['2025-01-01', '45658']])
  })

  it('honours the 1904 date system for date-styled numbers', () => {
    const xml = '<row r="1"><c r="A1" s="1"><v>44196</v></c></row>'

    const grid = parseXlsxWorksheetGrid(
      xml,
      context({ numberFormats: DATE_STYLES, use1904DateSystem: true })
    )

    expect(grid.rows).toEqual([['2025-01-01']])
  })

  it('keeps a date-styled cell that does not hold a number as stored', () => {
    const xml = '<row r="1"><c r="A1" s="1"><v>not-a-serial</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context({ numberFormats: DATE_STYLES }))

    expect(grid.rows).toEqual([['not-a-serial']])
  })

  it('reads an author-set row height and ignores a recorded default', () => {
    // Why: Excel writes `ht` on every row of some files just to record the
    // default; only customHeight marks the author's own choice.
    const xml =
      '<row r="1" ht="45" customHeight="1"><c r="A1"><v>1</v></c></row><row r="2" ht="15"><c r="A2"><v>2</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rowHeights[0]).toBe(60)
    expect(grid.rowHeights[1]).toBeUndefined()
  })

  it('applies a number format to a styled numeric cell', () => {
    // Why: a currency cell showing 1000 where the file says 1,000 € is the most
    // visible way a viewer can misrepresent a sheet.
    const currencyStyles = parseXlsxNumberFormats(
      '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0\\ &quot;€&quot;"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>'
    )
    const xml = '<row r="1"><c r="A1" s="1"><v>1000</v></c><c r="B1" s="0"><v>1000</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context({ numberFormats: currencyStyles }))

    expect(grid.rows).toEqual([['1,000 €', '1000']])
  })

  it('uses the negative section of a format code', () => {
    const accountingStyles = parseXlsxNumberFormats(
      '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0;(#,##0)"/></numFmts><cellXfs count="1"><xf numFmtId="164"/></cellXfs></styleSheet>'
    )
    const xml = '<row r="1"><c r="A1" s="0"><v>-50</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context({ numberFormats: accountingStyles }))

    expect(grid.rows).toEqual([['(50)']])
  })

  it('renders a number as stored without reformatting its precision', () => {
    const xml =
      '<row r="1"><c r="A1"><v>0.30000000000000004</v></c><c r="B1"><v>1E+21</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['0.30000000000000004', '1E+21']])
  })

  it('reads an empty cell and an out-of-range shared string index as blank', () => {
    const xml =
      '<row r="1"><c r="A1"/><c r="B1" t="s"><v>9</v></c><c r="C1" t="s"><v>x</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context({ sharedStrings: ['only'] }))

    expect(grid.rows).toEqual([['', '', '']])
  })

  it('decodes escaped markup in a cell value', () => {
    const xml = '<row r="1"><c r="A1" t="str"><v>a &lt; b &amp;&amp; c</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['a < b && c']])
  })

  it('stops at the row cap and reports the sheet as truncated', () => {
    const xml = Array.from(
      { length: 5 },
      (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`
    ).join('')

    const grid = parseXlsxWorksheetGrid(xml, context({ maxRows: 3 }))

    expect(grid.rows).toEqual([['0'], ['1'], ['2']])
    expect(grid.truncated).toBe(true)
  })

  it('does not report a sheet that exactly fills the cap as truncated', () => {
    const xml = '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context({ maxRows: 2 }))

    expect(grid.truncated).toBe(false)
  })

  it('caps a sheet whose first row already sits past the cap', () => {
    const xml = '<row r="900000"><c r="A900000"><v>1</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context({ maxRows: 1000 }))

    expect(grid.rows).toEqual([])
    expect(grid.truncated).toBe(true)
  })

  it('keeps reading rows after one row lands past the cap', () => {
    // Why: rows are normally ascending, but a hand-written sheet can list them
    // out of order — stopping at the first over-cap row would discard the rest.
    const xml =
      '<row r="1"><c r="A1"><v>1</v></c></row><row r="900"><c r="A900"><v>900</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context({ maxRows: 3 }))

    expect(grid.rows).toEqual([['1'], ['2']])
    expect(grid.truncated).toBe(true)
  })

  it('merges a repeated row element instead of appending a duplicate', () => {
    const xml = '<row r="1"><c r="A1"><v>1</v></c></row><row r="1"><c r="B1"><v>2</v></c></row>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['1', '2']])
  })

  it('returns an empty grid for a missing or empty sheet part', () => {
    const empty = {
      rows: [],
      styles: [],
      rowHeights: [],
      numericValues: new Map(),
      sparklineFormulas: new Map(),
      maxColumns: 0,
      truncated: false
    }

    expect(parseXlsxWorksheetGrid('', context())).toEqual(empty)
    expect(parseXlsxWorksheetGrid('<worksheet><sheetData/></worksheet>', context())).toEqual(empty)
  })

  it('does not mistake <cols> metadata for cell data', () => {
    const xml =
      '<cols><col min="1" max="1" width="20"/></cols><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'

    const grid = parseXlsxWorksheetGrid(xml, context())

    expect(grid.rows).toEqual([['1']])
    expect(grid.maxColumns).toBe(1)
  })
})

describe('parseXlsxWorksheetGrid numeric values', () => {
  it('collects a raw number only from the cells that hold one', () => {
    // Why: a shared string keeps its index in <v>, a boolean keeps 0 or 1 and an
    // error keeps a code — reading any of them would compare a rule against a
    // string's position in the table.
    const xml =
      '<row r="27"><c r="F27" t="s"><v>1</v></c><c r="G27" t="b"><v>1</v></c><c r="H27" t="e"><v>#DIV/0!</v></c><c r="I27"><v>-50</v></c></row>'

    const grid = parseXlsxWorksheetGrid(
      xml,
      context({ collectSparklines: true, sharedStrings: ['zero', 'one'] })
    )

    expect(grid.numericValues).toEqual(new Map([['26:8', -50]]))
  })

  it('collects nothing when the sheet carries no sparkline', () => {
    const grid = parseXlsxWorksheetGrid('<row r="1"><c r="A1"><v>7</v></c></row>', context())

    expect(grid.numericValues).toEqual(new Map())
  })
})
