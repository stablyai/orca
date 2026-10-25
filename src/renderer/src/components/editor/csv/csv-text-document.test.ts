import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv-parse'
import { detectCsvDelimiter } from './csv-delimiter-detection'
import { mutateCsvTextDocument, parseCsvTextDocument } from './csv-text-document'

describe('CSV text mutations', () => {
  it('rejects a range fill before repeated large values can exceed the editable file budget', () => {
    const document = parseCsvTextDocument('header\nfirst\nsecond', ',')
    expect(() =>
      mutateCsvTextDocument(document, {
        kind: 'cells',
        edits: [
          { row: 1, column: 0, value: 'x'.repeat(600_000) },
          { row: 2, column: 0, value: 'x'.repeat(600_000) }
        ]
      })
    ).toThrow('Table edits must stay below 1 MiB')
    expect(document.source).toBe('header\nfirst\nsecond')
  })
  it('quotes a remaining ambiguous column so reopening Auto does not split its values', () => {
    const document = parseCsvTextDocument('name;label,other\na;b,x', ',')
    const result = mutateCsvTextDocument(document, { kind: 'delete-columns', columns: [1] })
    expect(result).toBe('"name;label"\n"a;b"')
    expect(parseCsv(result, detectCsvDelimiter('data.csv', result)).rows).toEqual([
      ['name;label'],
      ['a;b']
    ])
  })
  it('retains other tokens, BOM, mixed record endings and absent final newline', () => {
    const source = '\ufeff"name",note\r\n"Ada","a""b"\nBob,"two\r\nlines"\rEnd,last'
    const document = parseCsvTextDocument(source, ',')
    expect(mutateCsvTextDocument(document, { kind: 'cells', edits: [] })).toBe(source)
    const result = mutateCsvTextDocument(document, {
      kind: 'cells',
      edits: [{ row: 2, column: 0, value: 'B,ob' }]
    })
    expect(result).toBe(source.replace('Bob,', '"B,ob",'))
    expect(parseCsv(result).rows[2]).toEqual(['B,ob', 'two\r\nlines'])
  })

  it.each([',', ';', '\t'])('safely round-trips edited values with %s', (delimiter) => {
    const values = [
      'quotes "inside"',
      'line\r\nbreak',
      `has${delimiter}delimiter`,
      '',
      '\ufeffliteral',
      '=literal'
    ]
    const document = parseCsvTextDocument(`header\nold`, delimiter)
    for (const value of values) {
      const result = mutateCsvTextDocument(document, {
        kind: 'cells',
        edits: [{ row: 1, column: 0, value }]
      })
      expect(parseCsv(result, delimiter).rows).toEqual([['header'], [value]])
    }
  })

  it('extends ragged rows without padding unaffected rows', () => {
    const document = parseCsvTextDocument('a,b,c\nshort\n1,2,3\n', ',')
    expect(
      mutateCsvTextDocument(document, {
        kind: 'cells',
        edits: [{ row: 1, column: 2, value: 'last' }]
      })
    ).toBe('a,b,c\nshort,,last\n1,2,3\n')
  })

  it('inserts and deletes rows while retaining the final-newline preference', () => {
    for (const ending of ['', '\r\n']) {
      const document = parseCsvTextDocument(`a\r\nfirst\r\nlast${ending}`, ',')
      expect(
        mutateCsvTextDocument(document, {
          kind: 'delete-rows',
          rows: [2]
        })
      ).toBe(`a\r\nfirst${ending}`)
      const result = mutateCsvTextDocument(document, {
        kind: 'insert-rows',
        at: 3,
        rows: [['']]
      })
      expect(result).toBe(`a\r\nfirst\r\nlast\r\n""${ending}`)
      expect(parseCsv(result).rows).toEqual([['a'], ['first'], ['last'], ['']])
    }
  })

  it('keeps an empty retained record when deleting the unterminated last row', () => {
    const document = parseCsvTextDocument('\nbody', ',')
    const result = mutateCsvTextDocument(document, { kind: 'delete-rows', rows: [1] })
    expect(result).toBe('""')
    expect(parseCsv(result).rows).toEqual([['']])
  })

  it('closes a permissive unterminated field before adding a following row', () => {
    const result = mutateCsvTextDocument(parseCsvTextDocument('a\n"open', ','), {
      kind: 'insert-rows',
      at: 2,
      rows: [['next']]
    })
    expect(parseCsv(result).rows).toEqual([['a'], ['open'], ['next']])
  })

  it('adds, deletes and reorders duplicate and blank columns using positions', () => {
    const document = parseCsvTextDocument('same,,same\n"01",,"03"\n1\n', ',')
    const moved = mutateCsvTextDocument(document, { kind: 'move-column', from: 2, to: 0 })
    expect(moved).toBe('same,same,\n"03","01",\n,1,\n')
    const inserted = mutateCsvTextDocument(document, {
      kind: 'insert-column',
      at: 1,
      label: 'new,name'
    })
    expect(parseCsv(inserted).rows).toEqual([
      ['same', 'new,name', '', 'same'],
      ['01', '', '', '03'],
      ['1', '', '', '']
    ])
    const deleted = mutateCsvTextDocument(document, { kind: 'delete-columns', columns: [0, 2] })
    expect(parseCsv(deleted).rows).toEqual([[''], [''], ['']])
    expect(mutateCsvTextDocument(document, { kind: 'delete-columns', columns: [0, 1, 2] })).toBe('')
  })

  it('creates a first column in an empty file and rejects stale or unsafe mutations', () => {
    expect(
      mutateCsvTextDocument(parseCsvTextDocument('\ufeff', ','), {
        kind: 'insert-column',
        at: 0,
        label: 'name'
      })
    ).toBe('\ufeffname')
    const document = parseCsvTextDocument('a\nx', ',')
    expect(() =>
      mutateCsvTextDocument(document, {
        kind: 'cells',
        edits: [{ row: 1, column: 1, value: 'wrong' }]
      })
    ).toThrow('no longer exists')
    expect(() =>
      mutateCsvTextDocument(document, {
        kind: 'cells',
        edits: [{ row: 1, column: 0, value: 'x'.repeat(1024 * 1024 + 1) }]
      })
    ).toThrow('record')
    expect(document.rows).toEqual([['a'], ['x']])
  })
})
