import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS,
  CSV_PARSE_LIMITS,
  type CsvParseLimits,
  detectCsvDelimiter,
  parseCsv
} from './csv-parse'

function parseLimits(overrides: Partial<CsvParseLimits>): CsvParseLimits {
  return { ...CSV_PARSE_LIMITS, ...overrides }
}

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

  it.each([
    {
      name: 'source code units',
      source: 'a,b\n',
      limits: parseLimits({ sourceCodeUnits: 3 }),
      reason: 'source-code-units'
    },
    {
      name: 'rows',
      source: 'a\nb\nc',
      limits: parseLimits({ rows: 2 }),
      reason: 'rows'
    },
    {
      name: 'columns per row',
      source: 'a,b,c',
      limits: parseLimits({ columnsPerRow: 2 }),
      reason: 'columns-per-row'
    },
    {
      name: 'total cells',
      source: 'a,b\nc,d,e',
      limits: parseLimits({ cells: 4 }),
      reason: 'cells'
    },
    {
      name: 'retained cell text',
      source: 'a,bcd',
      limits: parseLimits({ retainedCellCodeUnits: 3 }),
      reason: 'retained-cell-code-units'
    }
  ])('fails closed when $name exceeds its memory limit', ({ source, limits, reason }) => {
    expect(parseCsv(source, ',', limits)).toEqual({
      rows: [],
      maxColumns: 0,
      limitExceeded: { reason, limit: limits[reasonToLimitKey(reason)] }
    })
  })

  it('preserves exact output at every parser boundary', () => {
    const source = 'a,b\nc,d'
    const limits = parseLimits({
      sourceCodeUnits: source.length,
      rows: 2,
      columnsPerRow: 2,
      cells: 4,
      retainedCellCodeUnits: 4
    })

    expect(parseCsv(source, ',', limits)).toEqual({
      rows: [
        ['a', 'b'],
        ['c', 'd']
      ],
      maxColumns: 2,
      limitExceeded: null
    })
  })
})

function reasonToLimitKey(reason: string): keyof CsvParseLimits {
  switch (reason) {
    case 'source-code-units':
      return 'sourceCodeUnits'
    case 'rows':
      return 'rows'
    case 'columns-per-row':
      return 'columnsPerRow'
    case 'cells':
      return 'cells'
    default:
      return 'retainedCellCodeUnits'
  }
}

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
