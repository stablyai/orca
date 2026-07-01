import { describe, expect, it } from 'vitest'
import { buildSchemaRows, type SchemaTreeRow } from './schema-tree-rows'
import { dbColumnKey, type DbConnectionSchemaCache } from '@/store/slices/database'

function cache(overrides: Partial<DbConnectionSchemaCache> = {}): DbConnectionSchemaCache {
  return { schemas: [], truncated: false, tables: {}, columns: {}, ...overrides }
}

function types(rows: SchemaTreeRow[]): string[] {
  return rows.map((r) => r.type)
}

describe('buildSchemaRows', () => {
  it('lists collapsed schemas as single rows', () => {
    const rows = buildSchemaRows(
      cache({ schemas: ['public', 'app'] }),
      new Set(),
      new Set(),
      {}
    )
    expect(types(rows)).toEqual(['schema', 'schema'])
  })

  it('appends a loading row for an expanded schema whose tables are not cached', () => {
    const rows = buildSchemaRows(
      cache({ schemas: ['public'] }),
      new Set(['public']),
      new Set(),
      {}
    )
    expect(rows[1]).toMatchObject({ type: 'message', variant: 'loading', depth: 1 })
  })

  it('shows an error row when a schema-table load failed', () => {
    const rows = buildSchemaRows(
      cache({ schemas: ['public'] }),
      new Set(['public']),
      new Set(),
      { public: 'error' }
    )
    expect(rows[1]).toMatchObject({ type: 'message', variant: 'error' })
  })

  it('renders tables under an expanded schema and columns under an expanded table', () => {
    const tableKey = dbColumnKey('public', 'users')
    const rows = buildSchemaRows(
      cache({
        schemas: ['public'],
        tables: { public: { tables: [{ name: 'users', kind: 'table' }], truncated: false } },
        columns: {
          [tableKey]: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }]
        }
      }),
      new Set(['public']),
      new Set([tableKey]),
      {}
    )
    expect(types(rows)).toEqual(['schema', 'table', 'column'])
  })

  it('emits an overflow row when a schema truncated its tables', () => {
    const rows = buildSchemaRows(
      cache({
        schemas: ['public'],
        tables: { public: { tables: [{ name: 't', kind: 'table' }], truncated: true } }
      }),
      new Set(['public']),
      new Set(),
      {}
    )
    expect(rows.at(-1)).toMatchObject({ type: 'message', variant: 'overflow', depth: 1 })
  })

  it('emits an empty row for an expanded schema with no tables', () => {
    const rows = buildSchemaRows(
      cache({ schemas: ['public'], tables: { public: { tables: [], truncated: false } } }),
      new Set(['public']),
      new Set(),
      {}
    )
    expect(rows[1]).toMatchObject({ type: 'message', variant: 'empty' })
  })

  it('emits a top-level overflow row when schemas are truncated', () => {
    const rows = buildSchemaRows(
      cache({ schemas: ['public'], truncated: true }),
      new Set(),
      new Set(),
      {}
    )
    expect(rows.at(-1)).toMatchObject({ type: 'message', variant: 'overflow', depth: 0 })
  })
})
