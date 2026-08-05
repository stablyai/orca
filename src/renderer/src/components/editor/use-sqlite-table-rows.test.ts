// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SQLITE_ROW_CHUNK, useSqliteTableRows } from './use-sqlite-table-rows'
import type { SqliteTablePage } from '../../../../shared/sqlite-database'

type PageRequest = { table: string; offset: number; limit: number }

const readTablePage = vi.fn<(args: PageRequest) => Promise<SqliteTablePage>>()

function pageOf(table: string, offset: number, limit: number): SqliteTablePage {
  return {
    columns: [`${table}-col`],
    rows: Array.from({ length: limit }, (_, index) => [
      { type: 'text' as const, text: `${table}:${offset + index}` }
    ]),
    offset
  }
}

beforeEach(() => {
  readTablePage.mockReset()
  readTablePage.mockImplementation(async (args) => pageOf(args.table, args.offset, args.limit))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { sqlite: { readTablePage } }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSqliteTableRows', () => {
  it('fetches a chunk once, however often the viewport reports the same range', async () => {
    const { result } = renderHook(() => useSqliteTableRows('/db', 'people', 1000))

    act(() => result.current.ensureRange(0, 20))
    await waitFor(() => expect(result.current.getRow(0)).toBeDefined())

    act(() => result.current.ensureRange(0, 20))
    act(() => result.current.ensureRange(5, 25))
    expect(readTablePage).toHaveBeenCalledTimes(1)
  })

  it('maps a row index to its position inside the fetched chunk', async () => {
    const { result } = renderHook(() => useSqliteTableRows('/db', 'people', 1000))

    act(() => result.current.ensureRange(SQLITE_ROW_CHUNK, SQLITE_ROW_CHUNK + 1))
    await waitFor(() => expect(result.current.getRow(SQLITE_ROW_CHUNK)).toBeDefined())

    expect(result.current.getRow(SQLITE_ROW_CHUNK)?.[0]?.text).toBe(`people:${SQLITE_ROW_CHUNK}`)
  })

  it('drops a response that arrives after the table changed', async () => {
    let releaseFirst: ((page: SqliteTablePage) => void) | undefined
    readTablePage.mockImplementationOnce(
      async () =>
        new Promise<SqliteTablePage>((resolve) => {
          releaseFirst = resolve
        })
    )

    const { result, rerender } = renderHook(
      ({ table }: { table: string }) => useSqliteTableRows('/db', table, 1000),
      { initialProps: { table: 'people' } }
    )
    act(() => result.current.ensureRange(0, 10))

    rerender({ table: 'orders' })
    act(() => releaseFirst!(pageOf('people', 0, SQLITE_ROW_CHUNK)))
    await act(async () => {})

    expect(result.current.getRow(0)).toBeUndefined()
    expect(result.current.columns).not.toContain('people-col')
  })

  it('refetches a chunk that was evicted rather than leaving it blank forever', async () => {
    const { result } = renderHook(() => useSqliteTableRows('/db', 'people', 100_000))

    for (let chunk = 0; chunk < 70; chunk += 1) {
      const start = chunk * SQLITE_ROW_CHUNK
      act(() => result.current.ensureRange(start, start + 1))
      await waitFor(() => expect(result.current.getRow(start)).toBeDefined())
    }
    expect(result.current.getRow(0)).toBeUndefined()

    const callsBefore = readTablePage.mock.calls.length
    act(() => result.current.ensureRange(0, 1))
    await waitFor(() => expect(result.current.getRow(0)).toBeDefined())
    expect(readTablePage.mock.calls.length).toBe(callsBefore + 1)
  })

  it('surfaces a failed chunk read', async () => {
    readTablePage.mockRejectedValueOnce(new Error('database is locked'))
    const { result } = renderHook(() => useSqliteTableRows('/db', 'people', 1000))

    act(() => result.current.ensureRange(0, 10))
    await waitFor(() => expect(result.current.error).toBe('database is locked'))
  })
})
