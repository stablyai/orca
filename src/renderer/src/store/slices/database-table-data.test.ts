import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { DB_TABLE_PAGE_SIZE } from './database'
import { dbColumnKey } from './database'
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

// Stub the IPC surface loadDbTableData/openDbTableTab reach. `rows()` supplies
// the page the fake server returns so hasNext/slicing can be exercised.
function stubApi(rows: () => unknown[][]) {
  const execute = vi.fn(async (_args: { id: string; statement: DbStatement }) => ({
    ok: true as const,
    result: {
      columns: [{ name: 'id' }],
      rows: rows(),
      rowCount: rows().length,
      truncated: false,
      durationMs: 1
    }
  }))
  ;(globalThis as { window?: unknown }).window = {
    api: {
      database: {
        execute,
        introspectTableColumns: vi.fn(async () => ({ ok: true as const, columns: [] }))
      }
    }
  }
  return execute
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('table Data tab store flow', () => {
  it('opens a Data tab and loads the first page with pageSize+1 to detect a next page', async () => {
    const rows = Array.from({ length: DB_TABLE_PAGE_SIZE + 1 }, (_, i) => [i])
    const execute = stubApi(() => rows)
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })

    store.getState().openDbTableTab('c1', 'public', 'users')
    const tabId = dbColumnKey('public', 'users')
    // The tab + its initial fetch state exist synchronously.
    expect(store.getState().dbWorkspaceTabs.c1.tabs.map((t) => t.tabId)).toContain(tabId)
    await flush()

    const statement = execute.mock.calls[0][0].statement
    expect(statement.sql).toContain(`LIMIT ${DB_TABLE_PAGE_SIZE + 1} OFFSET 0`)
    const view = store.getState().dbTableData.c1[tabId]
    // pageSize+1 rows came back → a next page exists and the extra row is trimmed.
    expect(view.hasNext).toBe(true)
    expect(view.result?.rows).toHaveLength(DB_TABLE_PAGE_SIZE)
  })

  it('paging forward advances the offset by pageSize and re-queries', async () => {
    const execute = stubApi(() => [[1]])
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    store.getState().openDbTableTab('c1', 'public', 'users')
    const tabId = dbColumnKey('public', 'users')
    await flush()

    store.getState().setDbTablePage('c1', tabId, 1)
    expect(store.getState().dbTableData.c1[tabId].offset).toBe(DB_TABLE_PAGE_SIZE)
    await flush()
    const last = execute.mock.calls.at(-1)?.[0].statement
    expect(last?.sql).toContain(`OFFSET ${DB_TABLE_PAGE_SIZE}`)
  })

  it('sorting a column cycles direction, resets to the first page, and re-queries', async () => {
    const execute = stubApi(() => [[1]])
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    store.getState().openDbTableTab('c1', 'public', 'users')
    const tabId = dbColumnKey('public', 'users')
    await flush()

    store.getState().setDbTablePage('c1', tabId, 1) // move off page 1
    await flush()
    store.getState().setDbTableSort('c1', tabId, 'id')
    const view = store.getState().dbTableData.c1[tabId]
    expect(view.sorts).toEqual([{ column: 'id', direction: 'asc' }])
    expect(view.offset).toBe(0) // a new sort returns to the first page
    await flush()
    const last = execute.mock.calls.at(-1)?.[0].statement
    expect(last?.sql).toContain('ORDER BY "id" ASC')
  })
})
