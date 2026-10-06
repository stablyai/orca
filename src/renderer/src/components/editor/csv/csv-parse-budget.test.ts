import { expect, it } from 'vitest'
import { parseCsv } from './csv-parse'

it('parses large quoted spans and escaped quotes without character strings', () => {
  const large = 'a'.repeat(4 * 1024 * 1024)
  expect(parseCsv(`"${large}""b",tail`).rows).toEqual([[`${large}"b`, 'tail']])
})
it('keeps permissive empty quote reopening and text after quotes', () => {
  expect(parseCsv('""""x,"""a"b\n""""""')).toEqual({ rows: [['"x', '"ab'], ['""']], maxColumns: 2 })
})
it('bounds columns, cells and a single record', () => {
  expect(() => parseCsv(','.repeat(100_000), ',', { maxColumns: 4096 })).toThrow('cells')
  expect(() => parseCsv('a,b\nc,d', ',', { maxCells: 3 })).toThrow('cells')
  expect(() => parseCsv('abcd', ',', { maxRecordLength: 3 })).toThrow('record')
  expect(() => parseCsv('"a""', ',', { maxRecordLength: 3 })).toThrow('record')
})
it('retains a real BOM in a later page', () => {
  expect(parseCsv('\ufeffvalue', ',', { stripBom: false }).rows).toEqual([['\ufeffvalue']])
})

it('excludes BOMs and record terminators while counting quoted newlines toward the limit', () => {
  for (const bom of ['', '\ufeff']) {
    for (const ending of ['', '\n', '\r', '\r\n']) {
      for (const record of ['abcd', '"ab"', '"a\n"', '""""']) {
        expect(parseCsv(`${bom}${record}${ending}`, ',', { maxRecordLength: 4 })).toEqual(
          parseCsv(`${bom}${record}${ending}`)
        )
        expect(() => parseCsv(`${bom}${record}x${ending}`, ',', { maxRecordLength: 4 })).toThrow(
          'record'
        )
      }
    }
  }
})
