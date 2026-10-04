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

  it('sniffs semicolon exports that use commas as the decimal mark', () => {
    const content = 'amount;label\n1,50;"Roe, John"\n2,75;lunch\n'

    expect(detectCsvDelimiter('expenses.csv', content)).toBe(';')
    expect(parseCsv(content, detectCsvDelimiter('expenses.csv', content)).rows).toEqual([
      ['amount', 'label'],
      ['1,50', 'Roe, John'],
      ['2,75', 'lunch']
    ])
  })

  it('keeps comma when semicolons only appear inside quoted fields', () => {
    expect(detectCsvDelimiter('x.csv', '"a"";b;c",d,e\n1,2,3\n')).toBe(',')
  })

  it('prefers tab over semicolon when tabs dominate the first line', () => {
    expect(detectCsvDelimiter('x.csv', 'a\tb;c\td\n')).toBe('\t')
  })

  it('uses tab for .tsv files that contain semicolons', () => {
    expect(detectCsvDelimiter('data.TSV', 'a;b;c')).toBe('\t')
  })

  it.each([
    ['a;b,c', ','],
    ['a;b,c\td', ','],
    ['a;b\tc', '\t'],
    ['a,b\tc', ','],
    ['', ','],
    ['single', ',']
  ])('preserves existing delimiter precedence for %j', (content, delimiter) => {
    expect(detectCsvDelimiter('x.csv', content)).toBe(delimiter)
  })

  it('sniffs semicolons after a BOM and leading whitespace-only lines', () => {
    expect(detectCsvDelimiter('x.csv', '\uFEFF\n \t \r\na;b\n1;2')).toBe(';')
  })

  it('parses semicolon fields with quoted separators, escaped quotes and newlines', () => {
    const content = '\uFEFFnote;amount\r\n"she said ""hi"";\nnext";1,50\r\n'

    expect(parseCsv(content, detectCsvDelimiter('x.csv', content))).toEqual({
      rows: [
        ['note', 'amount'],
        ['she said "hi";\nnext', '1,50']
      ],
      maxColumns: 2
    })
  })

  it('keeps consistent comma columns when only the header has extra semicolons', () => {
    const content = 'notes;one;two,value\nplain,1\nother,2'

    expect(detectCsvDelimiter('x.csv', content)).toBe(',')
    expect(parseCsv(content, detectCsvDelimiter('x.csv', content)).rows).toEqual([
      ['notes;one;two', 'value'],
      ['plain', '1'],
      ['other', '2']
    ])
  })

  it.each([',', '\t'])('keeps literal quotes inside unquoted %j fields', (delimiter) => {
    const content = `notes;one;two${delimiter}value\n6" bolts${delimiter}1\nplain${delimiter}2`

    expect(detectCsvDelimiter('x.csv', content)).toBe(delimiter)
    expect(parseCsv(content, detectCsvDelimiter('x.csv', content)).rows).toEqual([
      ['notes;one;two', 'value'],
      ['6" bolts', '1'],
      ['plain', '2']
    ])
  })

  it('keeps consistent tab columns when a header contains extra semicolons', () => {
    expect(detectCsvDelimiter('x.csv', 'notes;one;two\tvalue\nplain\t1')).toBe('\t')
  })

  it('keeps a semicolon export whose unquoted comma counts vary between rows', () => {
    expect(detectCsvDelimiter('x.csv', 'name;amount;note\nAda;1,50;lunch\nBo;2;plain')).toBe(';')
  })

  it('ignores separator-like punctuation in a multiline quoted field', () => {
    const content = 'notes;one;two,value\n"line one\nline;two",1'
    expect(detectCsvDelimiter('x.csv', content)).toBe(',')
  })

  it('keeps first-line inference when the rows are ambiguous or ragged', () => {
    expect(detectCsvDelimiter('x.csv', 'a;b;c,value\nx;y;z,1')).toBe(';')
    expect(detectCsvDelimiter('x.csv', 'a;b;c\nx;y\nz')).toBe(';')
    expect(detectCsvDelimiter('x.csv', '1,50;coffee\n2,75;lunch')).toBe(',')
  })

  it('uses at most eight logical records to corroborate the existing delimiter', () => {
    const firstEight = ['notes;one;two,value', ...Array.from({ length: 7 }, () => 'plain,1')]
    const content = [...firstEight, 'ragged,one,two,three'].join('\n')
    expect(detectCsvDelimiter('x.csv', content)).toBe(',')
  })

  it('does not use an unfinished quoted record at the scan boundary as corroboration', () => {
    const prefix = 'notes;one;two,value\nplain,"'
    const content = `${prefix}${'x'.repeat(CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS)}",1`
    expect(detectCsvDelimiter('x.csv', content)).toBe(';')
  })

  it('does not use a partial unquoted record at the scan boundary as corroboration', () => {
    const prefix = 'notes;one;two,value\nplain,'
    const content = `${prefix}${'x'.repeat(CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS)}\nother,2`
    expect(detectCsvDelimiter('x.csv', content)).toBe(';')
  })

  it('does not corroborate an unfinished quoted record at EOF', () => {
    expect(detectCsvDelimiter('x.csv', 'notes;one;two,value\nplain,"unfinished')).toBe(';')
  })

  it('corroborates complete records with CRLF, escaped quotes and a quoted newline', () => {
    const content = 'notes;one;two,value\r\n"say ""hi"";\r\nnext",1\r\nplain,2\r\n'
    expect(detectCsvDelimiter('x.csv', content)).toBe(',')
  })

  it('does not sniff semicolons beyond the first-line scan limit', () => {
    const content = `${'a'.repeat(CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS)};b;c`

    expect(detectCsvDelimiter('x.csv', content)).toBe(',')
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
