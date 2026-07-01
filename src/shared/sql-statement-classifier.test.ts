import { describe, expect, it } from 'vitest'
import { isCursorableRead, needsWriteConfirm } from './sql-statement-classifier'

describe('isCursorableRead', () => {
  it.each([
    ['SELECT * FROM t', true],
    ['select 1', true],
    ['  SELECT 1;', true],
    ['WITH x AS (SELECT 1) SELECT * FROM x', true],
    ['VALUES (1), (2)', true],
    ['TABLE users', true],
    ['-- note\nSELECT 1', true],
    ['INSERT INTO t VALUES (1)', false],
    ['UPDATE t SET a = 1', false],
    ['SELECT 1; DROP TABLE x', false]
  ])('classifies %j as cursorable=%s', (sql, expected) => {
    expect(isCursorableRead(sql)).toBe(expected)
  })
})

describe('needsWriteConfirm', () => {
  it('does not confirm a plain single-statement read', () => {
    expect(needsWriteConfirm('SELECT * FROM t')).toBe(false)
    expect(needsWriteConfirm('SHOW TABLES')).toBe(false)
    expect(needsWriteConfirm('EXPLAIN SELECT 1')).toBe(false)
  })

  it('does not confirm when a write keyword only appears inside a string literal', () => {
    expect(needsWriteConfirm("SELECT * FROM logs WHERE action = 'DELETE'")).toBe(false)
  })

  it('confirms writes and DDL', () => {
    for (const sql of ['DELETE FROM t', 'DROP TABLE t', 'UPDATE t SET a=1', 'INSERT INTO t VALUES (1)']) {
      expect(needsWriteConfirm(sql)).toBe(true)
    }
  })

  it('confirms a writing CTE (not a keyword-at-start check)', () => {
    expect(needsWriteConfirm('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x')).toBe(true)
  })

  it('confirms multi-statement input even if it starts with SELECT', () => {
    expect(needsWriteConfirm('SELECT 1; DROP TABLE x')).toBe(true)
  })

  it('does not confirm empty input', () => {
    expect(needsWriteConfirm('   ')).toBe(false)
  })
})
