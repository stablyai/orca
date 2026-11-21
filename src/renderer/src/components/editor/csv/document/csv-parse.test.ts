import { describe, expect, it } from 'vitest'
import { detectCsvDelimiter } from './csv-delimiter-detection'
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

  it('corroborates complete records with CRLF, escaped quotes and a quoted newline', () => {
    const content = 'notes;one;two,value\r\n"say ""hi"";\r\nnext",1\r\nplain,2\r\n'
    expect(detectCsvDelimiter('x.csv', content)).toBe(',')
  })
})
