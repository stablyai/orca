import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { DB_TABLE_PAGE_SIZE } from './database'
import type { DbConnectionSummary, DbStatement } from '../../../../shared/database-types'

const originalWindow = (globalThis as { window?: unknown }).window
afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
  vi.restoreAllMocks()
})

function connection(): DbConnectionSummary {
  return {
    id: 'c1',
    name: 'db',
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'app',
    user: 'u',
    ssl: 'disable',
    readOnly: false,
    hasPassword: false,
    createdAt: 0,
    updatedAt: 0
  }
}

function stubApi(execRows: () => unknown[][]) {
  const query = vi.fn(async () => ({
    ok: true as const,
    result: {
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [[1, 2]],
      rowCount: 1,
      truncated: false,
      durationMs: 1
    }
  }))
  const execute = vi.fn(async (_args: { id: string; statement: DbStatement }) => ({
    ok: true as const,
    result: {
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: execRows(),
      rowCount: execRows().length,
      truncated: false,
      durationMs: 1
    }
  }))
  ;(globalThis as { window?: unknown }).window = { api: { database: { query, execute } } }
  return { query, execute }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('free-form query refine flow', () => {
  it('arms the refine view after running a single read', async () => {
    stubApi(() => [[1, 2]])
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    await store.getState().runDbQuery('c1', 'SELECT a, b FROM t')
    const refine = store.getState().dbQueryState.c1.refine
    expect(refine?.baseSql).toBe('SELECT a, b FROM t')
    expect(refine?.engaged).toBe(false)
  })

  it('does not arm refine for a non-read statement', async () => {
    stubApi(() => [])
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    await store.getState().runDbQuery('c1', 'UPDATE t SET a = 1')
    expect(store.getState().dbQueryState.c1.refine).toBeUndefined()
  })

  it('sorting re-runs the wrapped read by ordinal and marks it engaged', async () => {
    const { execute } = stubApi(() => [[3, 4]])
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    await store.getState().runDbQuery('c1', 'SELECT a, b FROM t')

    store.getState().setDbQuerySort('c1', 2)
    await flush()
    const statement = execute.mock.calls[0][0].statement
    expect(statement.sql).toBe(
      `SELECT * FROM (SELECT a, b FROM t) AS orca_sub ORDER BY 2 ASC LIMIT ${DB_TABLE_PAGE_SIZE + 1} OFFSET 0`
    )
    const refine = store.getState().dbQueryState.c1.refine
    expect(refine?.sort).toEqual({ ordinal: 2, direction: 'asc' })
    expect(refine?.engaged).toBe(true)
  })

  it('paging advances the wrapped OFFSET', async () => {
    const { execute } = stubApi(() => [[3, 4]])
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    await store.getState().runDbQuery('c1', 'SELECT a FROM t')
    store.getState().setDbQuerySort('c1', 1)
    await flush()
    store.getState().setDbQueryPage('c1', 1)
    await flush()
    const last = execute.mock.calls.at(-1)?.[0].statement
    expect(last?.sql).toContain(`OFFSET ${DB_TABLE_PAGE_SIZE}`)
  })
})
