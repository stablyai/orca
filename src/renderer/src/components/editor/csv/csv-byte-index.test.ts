import { describe, expect, it } from 'vitest'
import {
  CsvByteIndex,
  CSV_MAX_COLUMNS,
  CSV_MAX_PAGE_BYTES,
  CSV_RECORD_BYTES,
  csvPageForRow
} from './csv-byte-index'
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
  const samples = [
    '',
    '\ufeff',
    '""',
    '\n',
    'a,b\r\n1,2\r\n',
    'a\rb\nc\r\nd',
    'a,b,',
    '"a\r\nb","x""y"\n"",z',
    '"""";日本語\r\n"line\nline";😀',
    '""""""\n""""""',
    '""""x,1\n""""x,2',
    '"""";"unclosed\nfield',
    '""""\n\ufeffvalue'
  ]
  for (const delimiter of [',', ';', '\t']) {
    for (const chunkSize of [1, 2, 3, 7, 256 * 1024]) {
      it(`matches the parser for ${JSON.stringify(delimiter)} with ${chunkSize}-byte chunks`, () => {
        for (const source of samples) {
          const { bytes, result } = indexCsv(source, delimiter, chunkSize)
          const expected = parseCsv(source, delimiter)
          expect(result.rowCount, source).toBe(expected.rows.length)
          expect(result.columnCount, source).toBe(expected.maxColumns)
          const decoded = result.pages.flatMap(
            (page) =>
              parseCsv(
                new TextDecoder('utf-8', { ignoreBOM: true }).decode(
                  bytes.subarray(page.start, page.end)
                ),
                delimiter,
                { stripBom: page.start === 0 }
              ).rows
          )
          expect(decoded, source).toEqual(expected.rows)
        }
      })
    }
  }
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
  it('limits raw record bytes and empty columns before allocating any cells', () => {
    expect(() => indexCsv(`"${'x'.repeat(CSV_RECORD_BYTES)}`, ',', 1000)).toThrow('record')
    expect(() => indexCsv(','.repeat(CSV_MAX_COLUMNS), ',', 1000)).toThrow('column')
    expect(() => indexCsv('a\0b', ',', 1)).toThrow('binary')
  })
  it('matches parser limits at record boundaries with BOMs and every line ending', () => {
    const records = [
      'x'.repeat(CSV_RECORD_BYTES),
      `"${'x'.repeat(CSV_RECORD_BYTES - 2)}"`,
      `"${'x'.repeat(CSV_RECORD_BYTES - 3)}\n"`
    ]
    for (const bom of ['', '\ufeff']) {
      for (const ending of ['', '\n', '\r', '\r\n']) {
        for (const record of records) {
          const source = `${bom}${record}${ending}`
          const { bytes, result } = indexCsv(source, ',', 256 * 1024)
          expect(result.rowCount).toBe(1)
          expect(result.pages[0]!.end - result.pages[0]!.start).toBeLessThanOrEqual(
            CSV_MAX_PAGE_BYTES
          )
          const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
          expect(parseCsv(decoded, ',', { maxRecordLength: CSV_RECORD_BYTES })).toEqual(
            parseCsv(source)
          )
          expect(() => indexCsv(`${bom}${record}x${ending}`, ',', 256 * 1024)).toThrow('record')
        }
      }
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
  it('splits dense records by cell budget instead of only row count', () => {
    const source = `${','.repeat(CSV_MAX_COLUMNS - 1)}\n`.repeat(30)
    const { result } = indexCsv(source, ',', 256 * 1024)
    expect(result.rowCount).toBe(30)
    expect(result.pages.every((page) => page.rowCount <= 4)).toBe(true)
  })
})
