// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  decodeBase64Document,
  parsePresentationText,
  parseWorkbook,
  SPREADSHEET_PREVIEW_MAX_COLUMNS,
  SPREADSHEET_PREVIEW_MAX_ROWS
} from './office-document-parse'

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value
  }
  return new Uint8Array(value).buffer
}

describe('office document parsing', () => {
  it('decodes base64 without changing binary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255])
    const base64 = Buffer.from(bytes).toString('base64')
    expect(new Uint8Array(decodeBase64Document(base64))).toEqual(bytes)
  })

  it('extracts formatted worksheet values', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Summary')
    sheet.addRow(['Name', 'Count', 'Formula'])
    sheet.addRow(['Orca', 3, { formula: 'B2*2', result: 6 }])

    const buffer = toArrayBuffer(await workbook.xlsx.writeBuffer())
    await expect(parseWorkbook(buffer)).resolves.toEqual([
      {
        name: 'Summary',
        rows: [
          ['Name', 'Count', 'Formula'],
          ['Orca', '3', '6']
        ],
        truncated: false
      }
    ])
  })

  it('bounds sparse worksheets before materializing preview cells', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sparse')
    sheet.getCell('A1').value = 'Visible'
    sheet.getCell('CW10000').value = 'Outside preview'

    const buffer = toArrayBuffer(await workbook.xlsx.writeBuffer())
    const [parsed] = await parseWorkbook(buffer)

    expect(parsed?.rows).toHaveLength(SPREADSHEET_PREVIEW_MAX_ROWS)
    expect(parsed?.rows.every((row) => row.length === SPREADSHEET_PREVIEW_MAX_COLUMNS)).toBe(true)
    expect(parsed?.rows[0]?.[0]).toBe('Visible')
    expect(parsed?.truncated).toBe(true)
  })

  it('extracts fallback text from presentation slides', async () => {
    const archive = new JSZip()
    archive.file(
      'ppt/slides/slide10.xml',
      '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>'
    )
    archive.file(
      'ppt/slides/slide2.xml',
      '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>world</a:t></a:r></a:p></p:sld>'
    )
    const buffer = await archive.generateAsync({ type: 'arraybuffer' })

    await expect(parsePresentationText(buffer)).resolves.toEqual([
      { number: 2, paragraphs: ['Hello world'] },
      { number: 10, paragraphs: ['Last'] }
    ])
  })
})
