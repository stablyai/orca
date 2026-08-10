import { describe, expect, it } from 'vitest'
import { MAX_XLSX_SHEET_ROWS, parseXlsxWorkbook } from './xlsx-workbook'
import { buildXlsxWorkbook, buildZipArchive } from './xlsx-workbook-test-fixtures'

const DATE_STYLES_XML =
  '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>'

describe('parseXlsxWorkbook', () => {
  it('reads a workbook end to end from real zipped bytes', async () => {
    const bytes = buildXlsxWorkbook({
      sharedStrings: ['Region', 'Revenue', 'North'],
      sheets: [
        {
          name: 'Summary',
          sheetXml: `
            <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1250.5</v></c></row>
          `
        }
      ]
    })

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets).toHaveLength(1)
    expect(workbook.sheets[0]).toMatchObject({
      name: 'Summary',
      hidden: false,
      maxColumns: 2,
      truncated: false,
      rows: [
        ['Region', 'Revenue'],
        ['North', '1250.5']
      ]
    })
  })

  it('keeps worksheets in workbook order and flags hidden ones', async () => {
    const bytes = buildXlsxWorkbook({
      sheets: [
        { name: 'First', sheetXml: '<row r="1"><c r="A1"><v>1</v></c></row>' },
        { name: 'Secret', sheetXml: '<row r="1"><c r="A1"><v>2</v></c></row>', hidden: true },
        { name: 'Third', sheetXml: '<row r="1"><c r="A1"><v>3</v></c></row>' }
      ]
    })

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets.map((sheet) => [sheet.name, sheet.hidden, sheet.rows[0]?.[0]])).toEqual([
      ['First', false, '1'],
      ['Secret', true, '2'],
      ['Third', false, '3']
    ])
  })

  it('applies styles.xml date formats to the sheet values', async () => {
    const bytes = buildXlsxWorkbook({
      stylesXml: DATE_STYLES_XML,
      sheets: [
        {
          name: 'Dates',
          sheetXml:
            '<row r="1"><c r="A1" s="1"><v>45658</v></c><c r="B1" s="0"><v>45658</v></c></row>'
        }
      ]
    })

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets[0]?.rows).toEqual([['2025-01-01', '45658']])
  })

  it('reads dates in the 1904 system when the workbook declares it', async () => {
    const bytes = buildXlsxWorkbook({
      stylesXml: DATE_STYLES_XML,
      use1904DateSystem: true,
      sheets: [{ name: 'Dates', sheetXml: '<row r="1"><c r="A1" s="1"><v>44196</v></c></row>' }]
    })

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets[0]?.rows).toEqual([['2025-01-01']])
  })

  it('falls back to the conventional worksheet path when the rels part is missing', async () => {
    const bytes = buildXlsxWorkbook({
      omitWorkbookRels: true,
      sheets: [
        { name: 'One', sheetXml: '<row r="1"><c r="A1"><v>1</v></c></row>' },
        { name: 'Two', sheetXml: '<row r="1"><c r="A1"><v>2</v></c></row>' }
      ]
    })

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets.map((sheet) => sheet.rows[0]?.[0])).toEqual(['1', '2'])
  })

  it('follows the worksheet relationship rather than the sheet ordinal', async () => {
    // Why: r:id order does not have to match file numbering. Guessing from the
    // ordinal would silently show the wrong sheet's data under a tab's name.
    const bytes = buildZipArchive([
      {
        name: '_rels/.rels',
        content:
          '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
      },
      {
        name: 'xl/workbook.xml',
        content:
          '<workbook><sheets><sheet name="Only" sheetId="1" r:id="rId7"/></sheets></workbook>'
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<Relationships><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/renamed.xml"/></Relationships>'
      },
      {
        name: 'xl/worksheets/renamed.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>right</v></c></row></sheetData></worksheet>'
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>wrong</v></c></row></sheetData></worksheet>'
      }
    ])

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets[0]?.rows).toEqual([['right']])
  })

  it('locates the workbook part through the package relationships', async () => {
    const bytes = buildZipArchive([
      {
        name: '_rels/.rels',
        content:
          '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/spreadsheet/book.xml"/></Relationships>'
      },
      {
        name: 'spreadsheet/book.xml',
        content:
          '<workbook><sheets><sheet name="Elsewhere" sheetId="1" r:id="rId1"/></sheets></workbook>'
      },
      {
        name: 'spreadsheet/_rels/book.xml.rels',
        content:
          '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="sheets/one.xml"/></Relationships>'
      },
      {
        name: 'spreadsheet/sheets/one.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>found</v></c></row></sheetData></worksheet>'
      }
    ])

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets[0]).toMatchObject({ name: 'Elsewhere', rows: [['found']] })
  })

  it('renders a sheet whose worksheet part is missing as empty rather than failing', async () => {
    const bytes = buildZipArchive([
      {
        name: 'xl/workbook.xml',
        content:
          '<workbook><sheets><sheet name="Gone" sheetId="1" r:id="rId1"/></sheets></workbook>'
      }
    ])

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets[0]).toMatchObject({ name: 'Gone', rows: [], maxColumns: 0 })
  })

  it('reports a row cap hit on the sheet that hit it', async () => {
    const bytes = buildXlsxWorkbook({
      sheets: [
        {
          name: 'Huge',
          sheetXml: `<row r="1"><c r="A1"><v>1</v></c></row><row r="${MAX_XLSX_SHEET_ROWS + 1}"><c r="A${MAX_XLSX_SHEET_ROWS + 1}"><v>2</v></c></row>`
        }
      ]
    })

    const workbook = await parseXlsxWorkbook(bytes)

    expect(workbook.sheets[0]?.truncated).toBe(true)
    expect(workbook.sheets[0]?.rows).toHaveLength(1)
  })

  it('rejects a package with no workbook part', async () => {
    const bytes = buildZipArchive([{ name: '[Content_Types].xml', content: '<Types/>' }])

    await expect(parseXlsxWorkbook(bytes)).rejects.toThrow(/xl\/workbook\.xml is missing/)
  })

  it('rejects a workbook that declares no worksheets', async () => {
    const bytes = buildZipArchive([
      { name: 'xl/workbook.xml', content: '<workbook><sheets/></workbook>' }
    ])

    await expect(parseXlsxWorkbook(bytes)).rejects.toThrow(/declares no worksheets/)
  })

  it('rejects bytes that are not a zip container', async () => {
    await expect(parseXlsxWorkbook(new TextEncoder().encode('id,name\n1,a\n'))).rejects.toThrow(
      /end-of-central-directory record is missing/
    )
  })
})
