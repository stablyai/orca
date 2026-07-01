import { describe, expect, it } from 'vitest'
import {
  addNewRow,
  bufferChangeCount,
  bufferToStatements,
  discardNewRow,
  editNewRowCell,
  emptyEditBuffer,
  isBufferDirty,
  overlayCell,
  rowKeyFor,
  stageCellEdit,
  toggleDeleteRow
} from './table-data-edit-buffer'

const COLS = ['id', 'name', 'age']

describe('rowKeyFor', () => {
  it('keys a row by its primary-key values (positional to keyColumns)', () => {
    expect(rowKeyFor(['id'], COLS, [7, 'Al', 30])).toBe('[7]')
    expect(rowKeyFor(['id', 'name'], COLS, [7, 'Al', 30])).toBe('[7,"Al"]')
  })
})

describe('stageCellEdit', () => {
  it('stages a changed cell and un-stages when set back to the original', () => {
    let b = stageCellEdit(emptyEditBuffer(), '[7]', 'name', 'Bob', 'Al')
    expect(b.updates).toEqual({ '[7]': { name: 'Bob' } })
    b = stageCellEdit(b, '[7]', 'name', 'Al', 'Al')
    expect(b.updates).toEqual({})
  })

  it('treats a re-typed number string as unchanged (no no-op update)', () => {
    const b = stageCellEdit(emptyEditBuffer(), '[7]', 'age', '30', 30)
    expect(b.updates).toEqual({})
  })

  it('keeps NULL distinct from an empty string', () => {
    const b = stageCellEdit(emptyEditBuffer(), '[7]', 'name', '', null)
    expect(b.updates).toEqual({ '[7]': { name: '' } })
  })
})

describe('delete + new row staging', () => {
  it('toggles a row delete mark', () => {
    let b = toggleDeleteRow(emptyEditBuffer(), '[7]')
    expect(b.deletes).toEqual(['[7]'])
    b = toggleDeleteRow(b, '[7]')
    expect(b.deletes).toEqual([])
  })

  it('adds, edits, and discards a new row', () => {
    let b = addNewRow(emptyEditBuffer(), 'new-0')
    b = editNewRowCell(b, 'new-0', 'name', 'Zoe')
    expect(b.inserts).toEqual([{ tempId: 'new-0', values: { name: 'Zoe' } }])
    b = discardNewRow(b, 'new-0')
    expect(b.inserts).toEqual([])
  })
})

describe('overlayCell', () => {
  it('returns the staged value when edited, else the original', () => {
    const b = stageCellEdit(emptyEditBuffer(), '[7]', 'name', 'Bob', 'Al')
    expect(overlayCell(b, '[7]', 'name', 'Al')).toEqual({ value: 'Bob', hasEdit: true })
    expect(overlayCell(b, '[7]', 'age', 30)).toEqual({ value: 30, hasEdit: false })
  })
})

describe('bufferChangeCount / isBufferDirty', () => {
  it('counts edited + deleted + inserted rows', () => {
    let b = stageCellEdit(emptyEditBuffer(), '[7]', 'name', 'Bob', 'Al')
    b = toggleDeleteRow(b, '[8]')
    b = addNewRow(b, 'new-0')
    expect(bufferChangeCount(b)).toBe(3)
    expect(isBufferDirty(b)).toBe(true)
    expect(isBufferDirty(emptyEditBuffer())).toBe(false)
  })
})

describe('bufferToStatements', () => {
  const ctx = {
    schema: 'public',
    table: 'users',
    keyColumns: ['id'],
    columnNames: COLS,
    rowsByKey: { '[7]': [7, 'Al', 30], '[8]': [8, 'Bo', 25] }
  }

  it('emits DELETE, UPDATE (keyed by original PK), then INSERT — in that order', () => {
    let b = stageCellEdit(emptyEditBuffer(), '[7]', 'name', 'Bob', 'Al')
    b = toggleDeleteRow(b, '[8]')
    b = addNewRow(b, 'new-0')
    b = editNewRowCell(b, 'new-0', 'name', 'Zoe')

    const stmts = bufferToStatements('postgres', ctx, b)
    expect(stmts.map((s) => s.sql)).toEqual([
      'DELETE FROM "public"."users" WHERE "id" = $1',
      'UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2',
      'INSERT INTO "public"."users" ("name") VALUES ($1) RETURNING *'
    ])
    expect(stmts[0].params).toEqual([8])
    expect(stmts[1].params).toEqual(['Bob', 7])
    expect(stmts[2].params).toEqual(['Zoe'])
  })

  it('skips an update for a row that is also deleted', () => {
    let b = stageCellEdit(emptyEditBuffer(), '[7]', 'name', 'X', 'Al')
    b = toggleDeleteRow(b, '[7]')
    const stmts = bufferToStatements('postgres', ctx, b)
    expect(stmts.map((s) => s.sql)).toEqual(['DELETE FROM "public"."users" WHERE "id" = $1'])
  })

  it('keys an edited PK column update by the ORIGINAL pk value', () => {
    const b = stageCellEdit(emptyEditBuffer(), '[7]', 'id', 99, 7)
    const stmts = bufferToStatements('postgres', ctx, b)
    expect(stmts[0].sql).toBe('UPDATE "public"."users" SET "id" = $1 WHERE "id" = $2')
    expect(stmts[0].params).toEqual([99, 7])
  })

  it('throws (rather than binding undefined) when a staged row cannot be keyed', () => {
    const b = stageCellEdit(emptyEditBuffer(), '[999]', 'name', 'X', 'Al')
    expect(() => bufferToStatements('postgres', ctx, b)).toThrow()
  })
})
