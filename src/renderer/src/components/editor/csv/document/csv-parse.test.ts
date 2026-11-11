import { describe, expect, it } from 'vitest'
import { CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS, detectCsvDelimiter } from './csv-delimiter-detection'
import { parseCsv } from './csv-parse'

describe('parseCsv', () => {
  it('preserves a single quoted empty field at EOF', () => {
    const { rows } = parseCsv('""')
    expect(rows).toEqual([['']])
  })
})

describe('detectCsvDelimiter', () => {
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

  it.each([',', '\t'])('keeps literal quotes inside unquoted %j fields', (delimiter) => {
    const content = `notes;one;two${delimiter}value\n6" bolts${delimiter}1\nplain${delimiter}2`

    expect(detectCsvDelimiter('x.csv', content)).toBe(delimiter)
    expect(parseCsv(content, detectCsvDelimiter('x.csv', content)).rows).toEqual([
      ['notes;one;two', 'value'],
      ['6" bolts', '1'],
      ['plain', '2']
    ])
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

  it('corroborates complete records with CRLF, escaped quotes and a quoted newline', () => {
    const content = 'notes;one;two,value\r\n"say ""hi"";\r\nnext",1\r\nplain,2\r\n'
    expect(detectCsvDelimiter('x.csv', content)).toBe(',')
  })
})
