import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { emptySpreadsheetData, type SpreadsheetData } from './spreadsheet-data'
import { parseXlsxWorkbook, serializeXlsxWorkbook } from './excel-xlsx'

function toBase64(buffer: ExcelJS.Buffer): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return Buffer.from(bytes).toString('base64')
}

async function buildFixtures(): Promise<{ base64: string }> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  sheet.addRow(['name', 'qty', 'in stock'])
  sheet.addRow(['widget', 4, true])
  sheet.addRow(['gadget', 11, false])
  // Deliberately sparse row: column 1 empty, value in column 3.
  sheet.addRow([null, 0, 'tail'])
  sheet.getCell('C5').value = null
  sheet.addRow(['skipped-mid'])
  sheet.getCell('C6').value = 42
  return { base64: toBase64(await workbook.xlsx.writeBuffer()) }
}

describe('parseXlsxWorkbook', () => {
  it('round-trips cell values and names from an exceljs workbook', async () => {
    const { base64 } = await buildFixtures()
    const data = await parseXlsxWorkbook(base64)

    expect(data.worksheets).toHaveLength(1)
    expect(data.worksheets[0]!.name).toBe('Data')
    expect(data.worksheets[0]!.rows[0]).toEqual(['name', 'qty', 'in stock'])
    expect(data.worksheets[0]!.rows[1]).toEqual(['widget', 4, true])
    expect(data.worksheets[0]!.rows[2]).toEqual(['gadget', 11, false])
    // Sparse cells normalize to null with explicit gap fill.
    expect(data.worksheets[0]!.rows[3]).toEqual([null, 0, 'tail'])
    // The blank row is kept (not skipped), so later rows keep their index.
    expect(data.worksheets[0]!.rows[4]).toEqual([])
    expect(data.worksheets[0]!.rows[5]).toEqual(['skipped-mid', null, 42])
  })

  it('preserves blank rows instead of shifting later rows up', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Gaps')
    sheet.getCell('A1').value = 'first'
    sheet.getCell('A4').value = 'fourth'
    const data = await parseXlsxWorkbook(toBase64(await workbook.xlsx.writeBuffer()))

    const rows = data.worksheets[0]!.rows
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual(['first'])
    expect(rows[1]).toEqual([])
    expect(rows[2]).toEqual([])
    expect(rows[3]).toEqual(['fourth'])
  })

  it('flattens rich-text runs and keeps error values', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Rich')
    sheet.getCell('A1').value = {
      richText: [
        { font: { bold: true }, text: 'Hello ' },
        { font: { italic: true }, text: 'World' }
      ]
    } as never
    sheet.getCell('B1').value = { error: '#DIV/0!' } as never
    const data = await parseXlsxWorkbook(toBase64(await workbook.xlsx.writeBuffer()))

    expect(data.worksheets[0]!.rows[0]).toEqual(['Hello World', '#DIV/0!'])
  })

  it('rejects a buffer that is not a workbook', async () => {
    const garbage = Buffer.from('this is not a zip file').toString('base64')
    await expect(parseXlsxWorkbook(garbage)).rejects.toThrow()
  })

  it('returns empty worksheets when no rows exist', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Blank')
    const data = await parseXlsxWorkbook(toBase64(await workbook.xlsx.writeBuffer()))
    expect(data.worksheets[0]!.rows).toEqual([])
  })
})

describe('serializeXlsxWorkbook', () => {
  it('round-trips a SpreadsheetData back to readable cells', async () => {
    const data: SpreadsheetData = emptySpreadsheetData('Round')
    data.worksheets[0]!.rows = [
      ['a', 'b'],
      [1, 'two'],
      [null, true]
    ]
    const base64 = await serializeXlsxWorkbook(data)
    const parsed = await parseXlsxWorkbook(base64)
    expect(parsed.worksheets[0]!.name).toBe('Round')
    expect(parsed.worksheets[0]!.rows).toEqual([
      ['a', 'b'],
      [1, 'two'],
      [null, true]
    ])
  })

  it('keeps blank rows so a save never shifts later rows up', async () => {
    const data: SpreadsheetData = emptySpreadsheetData('Gaps')
    data.worksheets[0]!.rows = [['first'], [], [], ['fourth']]
    const parsed = await parseXlsxWorkbook(await serializeXlsxWorkbook(data))
    const rows = parsed.worksheets[0]!.rows
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual(['first'])
    expect(rows[1]).toEqual([])
    expect(rows[2]).toEqual([])
    expect(rows[3]).toEqual(['fourth'])
  })

  it('serializes multiple worksheets preserving names', async () => {
    const data: SpreadsheetData = {
      worksheets: [
        { name: 'One', rows: [['x']] },
        { name: 'Two', rows: [['y', 2]] }
      ],
      activeSheetIndex: 1
    }
    const base64 = await serializeXlsxWorkbook(data)
    const parsed = await parseXlsxWorkbook(base64)
    expect(parsed.worksheets.map((ws) => ws.name)).toEqual(['One', 'Two'])
    expect(parsed.worksheets[1]!.rows).toEqual([['y', 2]])
  })
})
