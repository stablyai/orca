import { describe, expect, it } from 'vitest'
import { CsvByteIndex, csvPageForRow } from './csv-byte-index'
import { parseCsv } from './csv-parse'

function indexCsv(source: string, delimiter: string, chunkSize: number) {
  const bytes = new TextEncoder().encode(source)
  const index = new CsvByteIndex(delimiter.charCodeAt(0))
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    index.feed(bytes.subarray(offset, offset + chunkSize))
  }
  return { bytes, result: index.finish() }
}

describe('CSV byte index', () => {
  it('round-trips many pages with Unicode, escaped quotes, mixed line endings and ragged rows', () => {
    const rows = Array.from({ length: 1800 }, (_, i) => [
      String(i),
      `😀;${i}\r\n"quoted"`,
      ...(i % 3 ? [] : [''])
    ])
    const source = `\ufeff${rows.map((row, i) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(';') + ['\n', '\r\n', '\r'][i % 3]).join('')}`
    const { bytes, result } = indexCsv(source, ';', 7)
    expect(result.pages.length).toBeGreaterThan(4)
    expect(
      result.pages.flatMap(
        (page) => parseCsv(new TextDecoder().decode(bytes.subarray(page.start, page.end)), ';').rows
      )
    ).toEqual(rows)
    for (let row = 0; row < rows.length; row += 1) {
      const page = result.pages[csvPageForRow(result.pages, row)]!
      expect(row).toBeGreaterThanOrEqual(page.firstRow)
      expect(row).toBeLessThan(page.firstRow + page.rowCount)
    }
  })
  it('preserves a real BOM character at a later page boundary', () => {
    const source = `${'value\n'.repeat(256)}\ufefflast\n`
    const { bytes, result } = indexCsv(source, ',', 7)
    const page = result.pages[1]!
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      bytes.subarray(page.start, page.end)
    )
    expect(parseCsv(text, ',', { stripBom: false }).rows).toEqual([['\ufefflast']])
  })
})
