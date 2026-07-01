import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { dbColumnKey } from './database'
import type { DbConnectionSummary, DbStatement } from '../../../../shared/database-types'

const originalWindow = (globalThis as { window?: unknown }).window
afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
  vi.restoreAllMocks()
})

function connection(readOnly = false): DbConnectionSummary {
  return {
    id: 'c1',
    name: 'db',
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'app',
    user: 'u',
    ssl: 'disable',
    readOnly,
    hasPassword: false,
    createdAt: 0,
    updatedAt: 0
  }
}

// A single row [1,'Al'] with an `id` primary key + a `name` column.
function stubApi(batchOk = true) {
  const execute = vi.fn(async () => ({
    ok: true as const,
    result: {
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [[1, 'Al']],
      rowCount: 1,
      truncated: false,
      durationMs: 1
    }
  }))
  const executeBatch = vi.fn(async (_args: { id: string; statements: DbStatement[] }) =>
    batchOk
      ? ({ ok: true as const, rowCounts: [1] })
      : ({ ok: false as const, error: { code: 'x', safeMessage: 'bad' }, failedIndex: 0 })
  )
  const introspectTableColumns = vi.fn(async () => ({
    ok: true as const,
    columns: [
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
      { name: 'name', dataType: 'text', nullable: true, isPrimaryKey: false }
    ]
  }))
  ;(globalThis as { window?: unknown }).window = {
    api: { database: { execute, executeBatch, introspectTableColumns } }
  }
  return { execute, executeBatch }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('table Data tab editing', () => {
  it('saves a staged cell edit as a keyed UPDATE and clears the buffer on success', async () => {
    const { executeBatch } = stubApi(true)
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    store.getState().openDbTableTab('c1', 'public', 'users')
    const tabId = dbColumnKey('public', 'users')
    await flush()

    // Edit the `name` cell of the row whose id=1.
    store.getState().stageDbCellEdit('c1', tabId, '[1]', 'name', 'Bob', 'Al')
    expect(store.getState().dbTableData.c1[tabId].edit.updates).toEqual({ '[1]': { name: 'Bob' } })

    const ok = await store.getState().saveDbEdits('c1', tabId)
    expect(ok).toBe(true)
    const statements = executeBatch.mock.calls[0][0].statements
    expect(statements[0].sql).toBe('UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2')
    expect(statements[0].params).toEqual(['Bob', 1])
    await flush()
    // A successful save reloads and clears the staged buffer.
    expect(store.getState().dbTableData.c1[tabId].edit.updates).toEqual({})
  })

  it('keeps the buffer and records the error when the batch fails', async () => {
    stubApi(false)
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    store.getState().openDbTableTab('c1', 'public', 'users')
    const tabId = dbColumnKey('public', 'users')
    await flush()

    store.getState().stageDbCellEdit('c1', tabId, '[1]', 'name', 'Bob', 'Al')
    const ok = await store.getState().saveDbEdits('c1', tabId)
    expect(ok).toBe(false)
    const view = store.getState().dbTableData.c1[tabId]
    expect(view.edit.updates).toEqual({ '[1]': { name: 'Bob' } })
    expect(view.saveError?.safeMessage).toBe('bad')
  })

  it('refuses to save when the table has no primary key', async () => {
    const { executeBatch } = stubApi(true)
    ;(globalThis as { window?: { api: { database: { introspectTableColumns: unknown } } } }).window!.api.database.introspectTableColumns =
      vi.fn(async () => ({ ok: true as const, columns: [{ name: 'name', dataType: 'text', nullable: true, isPrimaryKey: false }] }))
    const store = createTestStore()
    store.setState({ dbConnections: [connection()] })
    store.getState().openDbTableTab('c1', 'public', 'nopk')
    const tabId = dbColumnKey('public', 'nopk')
    await flush()

    store.getState().stageDbCellEdit('c1', tabId, '[1]', 'name', 'Bob', 'Al')
    const ok = await store.getState().saveDbEdits('c1', tabId)
    expect(ok).toBe(false)
    expect(executeBatch).not.toHaveBeenCalled()
  })
})
