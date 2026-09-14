import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv-parse'
import { serializeCsvRows } from './csv-serialize'

describe('serializeCsvRows', () => {
  it('round-trips simple comma rows with CRLF', () => {
    const rows: (string | number | null)[][] = [
      ['name', 'qty'],
      ['widget', 4],
      ['gadget', null]
    ]
    const csv = serializeCsvRows(rows, ',')
    expect(csv).toBe('name,qty\r\nwidget,4\r\ngadget,')
    expect(parseCsv(csv, ',')).toEqual({
      rows: [
        ['name', 'qty'],
        ['widget', '4'],
        ['gadget', '']
      ],
      maxColumns: 2
    })
  })

  it('quotes fields containing the delimiter, quotes, or newlines', () => {
    const rows: string[][] = [['a,1', 'say "hi"', 'multi\nline']]
    const csv = serializeCsvRows(rows, ',')
    expect(csv).toBe('"a,1","say ""hi""","multi\nline"')
    const parsed = parseCsv(csv, ',').rows[0]!
    expect(parsed).toEqual(['a,1', 'say "hi"', 'multi\nline'])
  })

  it('uses the tab delimiter for tab-separated output', () => {
    const rows: string[][] = [['a', 'b']]
    expect(serializeCsvRows(rows, '\t')).toBe('a\tb')
  })
})
