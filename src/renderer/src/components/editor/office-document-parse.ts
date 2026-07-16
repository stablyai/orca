import ExcelJS from 'exceljs'
import JSZip from 'jszip'

export type SpreadsheetSheet = {
  name: string
  rows: string[][]
  truncated: boolean
}

export const SPREADSHEET_PREVIEW_MAX_ROWS = 200
export const SPREADSHEET_PREVIEW_MAX_COLUMNS = 100

export type PresentationSlide = {
  number: number
  paragraphs: string[]
}

export function decodeBase64Document(content: string): ArrayBuffer {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

function stringifyCellValue(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value !== 'object') {
    return String(value)
  }
  if ('text' in value) {
    return String(value.text)
  }
  if ('result' in value) {
    return String(value.result ?? '')
  }
  if ('richText' in value) {
    return value.richText.map((part) => part.text).join('')
  }
  return JSON.stringify(value)
}

export async function parseWorkbook(buffer: ArrayBuffer): Promise<SpreadsheetSheet[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheets: SpreadsheetSheet[] = []

  workbook.eachSheet((sheet) => {
    const rows: string[][] = []
    const rowCount = Math.min(sheet.rowCount, SPREADSHEET_PREVIEW_MAX_ROWS)
    const columnCount = Math.min(sheet.columnCount, SPREADSHEET_PREVIEW_MAX_COLUMNS)
    for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber)
      const values: string[] = []
      for (let column = 1; column <= columnCount; column += 1) {
        values.push(stringifyCellValue(row.getCell(column).value))
      }
      rows.push(values)
    }
    sheets.push({
      name: sheet.name,
      rows,
      truncated:
        sheet.rowCount > SPREADSHEET_PREVIEW_MAX_ROWS ||
        sheet.columnCount > SPREADSHEET_PREVIEW_MAX_COLUMNS
    })
  })

  return sheets
}

function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? Number.MAX_SAFE_INTEGER)
}

export async function parsePresentationText(buffer: ArrayBuffer): Promise<PresentationSlide[]> {
  const archive = await JSZip.loadAsync(buffer)
  const paths = Object.keys(archive.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((left, right) => slideNumber(left) - slideNumber(right))

  return Promise.all(
    paths.map(async (path) => {
      const xml = await archive.file(path)!.async('string')
      const document = new DOMParser().parseFromString(xml, 'application/xml')
      const elements = Array.from(document.getElementsByTagName('*'))
      const paragraphs = elements
        .filter((element) => element.localName === 'p')
        .map((paragraph) =>
          Array.from(paragraph.getElementsByTagName('*'))
            .filter((element) => element.localName === 't')
            .map((text) => text.textContent ?? '')
            .join('')
            .trim()
        )
        .filter(Boolean)
      return { number: slideNumber(path), paragraphs }
    })
  )
}
