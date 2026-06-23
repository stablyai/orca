import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS, detectCsvDelimiter, parseCsv } from './csv-parse'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseCsv', () => {
  it('parses basic rows', () => {
    const { rows, maxColumns } = parseCsv('a,b,c\n1,2,3\n')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
    expect(maxColumns).toBe(3)
  })

  it('handles quoted fields with delimiters and escaped quotes', () => {
    const { rows } = parseCsv('name,note\n"Doe, Jane","she said ""hi"""\n')
    expect(rows).toEqual([
      ['name', 'note'],
      ['Doe, Jane', 'she said "hi"']
    ])
  })

  it('handles CRLF and embedded newlines inside quotes', () => {
    const { rows } = parseCsv('a,b\r\n"x\ny",z\r\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['x\ny', 'z']
    ])
  })

  it('tracks the widest row for ragged data', () => {
    const { rows, maxColumns } = parseCsv('a,b\n1,2,3\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2', '3']
    ])
    expect(maxColumns).toBe(3)
  })

  it('preserves a final row without trailing newline', () => {
    const { rows } = parseCsv('a,b\n1,2')
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('parses TSV when delimiter is tab', () => {
    const { rows } = parseCsv('a\tb\n1\t2\n', '\t')
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('strips a leading UTF-8 BOM from the first header cell', () => {
    const { rows } = parseCsv('\uFEFFa,b,c\n1,2,3\n')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
  })

  it('preserves a single quoted empty field at EOF', () => {
    const { rows } = parseCsv('""')
    expect(rows).toEqual([['']])
  })
})

describe('detectCsvDelimiter', () => {
  it('uses tab for .tsv files regardless of content', () => {
    expect(detectCsvDelimiter('data.tsv', 'a,b,c')).toBe('\t')
  })

  it('sniffs tab vs comma from the first line', () => {
    expect(detectCsvDelimiter('data.csv', 'a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectCsvDelimiter('data.csv', 'a,b,c\n1,2,3')).toBe(',')
  })

  it('skips leading blank lines when sniffing', () => {
    expect(detectCsvDelimiter('x.csv', '\n\na\tb\tc')).toBe('\t')
  })

  it('skips CR-only blank lines when sniffing', () => {
    expect(detectCsvDelimiter('x.csv', '\r\ra\tb\tc')).toBe('\t')
  })

  it('strips a leading BOM before sniffing', () => {
    expect(detectCsvDelimiter('x.csv', '\uFEFFa\tb\tc')).toBe('\t')
  })

  it('ignores delimiters inside quoted fields when sniffing', () => {
    const content = '"Doe, Jane"\tAge\n"Roe, John"\t42\n'

    expect(detectCsvDelimiter('contacts.csv', content)).toBe('\t')
    expect(parseCsv(content, detectCsvDelimiter('contacts.csv', content)).rows).toEqual([
      ['Doe, Jane', 'Age'],
      ['Roe, John', '42']
    ])
  })

  it('bounds newline-heavy delimiter sniffing without splitting the full file', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const content = `${'\n'.repeat(CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS + 10_000)}a\tb\tc`

    expect(detectCsvDelimiter('x.csv', content)).toBe(',')

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThanOrEqual(
      CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS + 1
    )
  })
})
