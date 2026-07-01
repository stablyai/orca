import { describe, expect, it } from 'vitest'
import {
  buildCountSql,
  buildDeleteByKeySql,
  buildInsertSql,
  buildSelectSql,
  buildUpdateByKeySql,
  buildWrappedQuerySql
} from './table-data-sql'

describe('buildSelectSql', () => {
  it('builds a plain page with engine-quoted identifiers and interpolated LIMIT/OFFSET', () => {
    expect(buildSelectSql('postgres', { schema: 'public', table: 'users', limit: 100, offset: 0 })).toEqual({
      sql: 'SELECT * FROM "public"."users" LIMIT 100 OFFSET 0',
      params: []
    })
    expect(buildSelectSql('mysql', { schema: 'app', table: 'users', limit: 50, offset: 50 })).toEqual({
      sql: 'SELECT * FROM `app`.`users` LIMIT 50 OFFSET 50',
      params: []
    })
  })

  it('binds filter values as params and orders by column name', () => {
    const pg = buildSelectSql('postgres', {
      schema: 'public',
      table: 't',
      filters: [
        { column: 'name', operator: 'like', value: '%a%' },
        { column: 'age', operator: '>=', value: 18 },
        { column: 'deleted', operator: 'is-null' }
      ],
      sorts: [
        { column: 'age', direction: 'desc' },
        { column: 'name', direction: 'asc' }
      ],
      limit: 25,
      offset: 0
    })
    expect(pg.sql).toBe(
      'SELECT * FROM "public"."t" WHERE "name" LIKE $1 AND "age" >= $2 AND "deleted" IS NULL' +
        ' ORDER BY "age" DESC, "name" ASC LIMIT 25 OFFSET 0'
    )
    expect(pg.params).toEqual(['%a%', 18])
  })

  it('uses ? placeholders and ILIKE→LIKE fallback on MySQL', () => {
    const my = buildSelectSql('mysql', {
      schema: 'app',
      table: 't',
      filters: [{ column: 'name', operator: 'ilike', value: 'bob' }],
      limit: 10,
      offset: 0
    })
    expect(my.sql).toBe('SELECT * FROM `app`.`t` WHERE `name` LIKE ? LIMIT 10 OFFSET 0')
    expect(my.params).toEqual(['bob'])
  })

  it('clamps negative/non-integer paging values', () => {
    const s = buildSelectSql('postgres', { schema: 's', table: 't', limit: 10.9, offset: -5 })
    expect(s.sql).toContain('LIMIT 10 OFFSET 0')
  })

  it('escapes a quote in an identifier so it cannot break out', () => {
    const s = buildSelectSql('postgres', { schema: 'pu"blic', table: 't', limit: 1, offset: 0 })
    expect(s.sql).toBe('SELECT * FROM "pu""blic"."t" LIMIT 1 OFFSET 0')
  })
})

describe('buildCountSql', () => {
  it('counts with the same filter predicate', () => {
    const c = buildCountSql('postgres', {
      schema: 'public',
      table: 't',
      filters: [{ column: 'active', operator: '=', value: true }]
    })
    expect(c).toEqual({
      sql: 'SELECT COUNT(*) AS count FROM "public"."t" WHERE "active" = $1',
      params: [true]
    })
  })
})

describe('buildUpdateByKeySql', () => {
  it('binds SET values before WHERE key values so placeholder order matches params', () => {
    const u = buildUpdateByKeySql('postgres', {
      schema: 'public',
      table: 'users',
      set: { name: 'Bob', email: 'b@x.com' },
      keyColumns: ['id'],
      keyValues: [7]
    })
    expect(u.sql).toBe('UPDATE "public"."users" SET "name" = $1, "email" = $2 WHERE "id" = $3')
    expect(u.params).toEqual(['Bob', 'b@x.com', 7])
  })

  it('supports a composite key', () => {
    const u = buildUpdateByKeySql('mysql', {
      schema: 'app',
      table: 't',
      set: { v: 1 },
      keyColumns: ['a', 'b'],
      keyValues: [10, 20]
    })
    expect(u.sql).toBe('UPDATE `app`.`t` SET `v` = ? WHERE `a` = ? AND `b` = ?')
    expect(u.params).toEqual([1, 10, 20])
  })
})

describe('buildInsertSql', () => {
  it('inserts named columns; Postgres returns the row', () => {
    const i = buildInsertSql('postgres', {
      schema: 'public',
      table: 't',
      values: { name: 'Al', age: 30 }
    })
    expect(i.sql).toBe('INSERT INTO "public"."t" ("name", "age") VALUES ($1, $2) RETURNING *')
    expect(i.params).toEqual(['Al', 30])
  })

  it('has no RETURNING on MySQL', () => {
    const i = buildInsertSql('mysql', { schema: 'app', table: 't', values: { name: 'Al' } })
    expect(i.sql).toBe('INSERT INTO `app`.`t` (`name`) VALUES (?)')
    expect(i.params).toEqual(['Al'])
  })

  it('falls back to all-default values when no columns are set', () => {
    expect(buildInsertSql('postgres', { schema: 's', table: 't', values: {} }).sql).toBe(
      'INSERT INTO "s"."t" DEFAULT VALUES RETURNING *'
    )
    expect(buildInsertSql('mysql', { schema: 's', table: 't', values: {} }).sql).toBe(
      'INSERT INTO `s`.`t` () VALUES ()'
    )
  })
})

describe('buildDeleteByKeySql', () => {
  it('deletes by key', () => {
    const d = buildDeleteByKeySql('postgres', {
      schema: 'public',
      table: 't',
      keyColumns: ['id'],
      keyValues: [42]
    })
    expect(d).toEqual({ sql: 'DELETE FROM "public"."t" WHERE "id" = $1', params: [42] })
  })
})

describe('buildWrappedQuerySql', () => {
  it('wraps a free-form read, sorts by ordinal, filters by name, strips trailing ;', () => {
    const w = buildWrappedQuerySql('postgres', 'SELECT a, b FROM t;  ', {
      filters: [{ column: 'b', operator: '=', value: 5 }],
      sorts: [{ ordinal: 2, direction: 'desc' }],
      limit: 100,
      offset: 200
    })
    expect(w.sql).toBe(
      'SELECT * FROM (SELECT a, b FROM t) AS orca_sub WHERE "b" = $1 ORDER BY 2 DESC LIMIT 100 OFFSET 200'
    )
    expect(w.params).toEqual([5])
  })

  it('wraps without sort/filter', () => {
    const w = buildWrappedQuerySql('mysql', 'SELECT 1', { limit: 10, offset: 0 })
    expect(w.sql).toBe('SELECT * FROM (SELECT 1) AS orca_sub LIMIT 10 OFFSET 0')
    expect(w.params).toEqual([])
  })
})
