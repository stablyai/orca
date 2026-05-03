import { describe, expect, it } from 'vitest'
import { detectCsvDelimiter, parseCsv } from './csv-parse'

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

  it('strips a leading BOM before sniffing', () => {
    expect(detectCsvDelimiter('x.csv', '\uFEFFa\tb\tc')).toBe('\t')
  })
})
