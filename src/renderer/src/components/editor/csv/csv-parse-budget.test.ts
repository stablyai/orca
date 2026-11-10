import { expect, it } from 'vitest'
import { parseCsv } from './csv-parse'
it('bounds columns, cells and a single record', () => {
  expect(() => parseCsv(','.repeat(100_000), ',', { maxColumns: 4096 })).toThrow('cells')
  expect(() => parseCsv('a,b\nc,d', ',', { maxCells: 3 })).toThrow('cells')
  expect(() => parseCsv('abcd', ',', { maxRecordLength: 3 })).toThrow('record')
  expect(() => parseCsv('"a""', ',', { maxRecordLength: 3 })).toThrow('record')
})
it('retains a real BOM in a later page', () => {
  expect(parseCsv('\ufeffvalue', ',', { stripBom: false }).rows).toEqual([['\ufeffvalue']])
})
