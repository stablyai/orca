// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCsvPagedPreview } from './useCsvPagedPreview'

const mocks = vi.hoisted(() => ({
  buildIndex: vi.fn(),
  page: vi.fn(),
  rows: vi.fn(),
  close: vi.fn()
}))
vi.mock('./csv-paged-preview', () => ({
  CsvPagedPreview: class {
    buildIndex = mocks.buildIndex
    page = mocks.page
    rows = mocks.rows
    close = mocks.close
  }
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('keeps the new viewport loader alive when a canceled delimiter scan rejects late', async () => {
  let rejectOld!: (error: Error) => void
  const oldScan = new Promise<never>((_resolve, reject) => {
    rejectOld = reject
  })
  const pages = [{ start: 0, end: 20, firstRow: 0, rowCount: 4 }]
  mocks.buildIndex
    .mockReturnValueOnce(oldScan)
    .mockResolvedValue({ pages, rowCount: 4, columnCount: 1 })
  mocks.page.mockResolvedValue([['id'], ['first'], ['second'], ['third']])
  mocks.rows.mockResolvedValue(
    new Map([
      [1, ['second']],
      [2, ['third']]
    ])
  )
  const file = {
    readArgs: { settings: null, filePath: '/repo/a.csv' },
    snapshot: { size: 20, mtime: 1, isDirectory: false }
  }
  const { result, rerender } = renderHook(({ delimiter }) => useCsvPagedPreview(file, delimiter), {
    initialProps: { delimiter: ',' }
  })
  rerender({ delimiter: ';' })
  await waitFor(() => expect(result.current.header).toEqual(['id']))
  await act(async () => {
    rejectOld(new Error('old scan canceled'))
  })
  expect(result.current.error).toBeNull()
  act(() => result.current.onVisibleRows(1, 2))
  await waitFor(() => expect(result.current.getRow(2)).toEqual(['third']))
  expect(mocks.rows).toHaveBeenCalledTimes(1)
  expect(mocks.page).toHaveBeenCalledTimes(1)
  expect(mocks.close).toHaveBeenCalledTimes(1)
})

it('coalesces rapid scrolls and releases rows outside the latest viewport', async () => {
  const pages = Array.from({ length: 4 }, (_, i) => ({
    start: i * 20,
    end: (i + 1) * 20,
    firstRow: i * 4,
    rowCount: 4
  }))
  mocks.buildIndex.mockResolvedValue({ pages, rowCount: 16, columnCount: 1 })
  mocks.page.mockImplementation(async (index: number) =>
    Array.from({ length: 4 }, (_, offset) => [String(index * 4 + offset)])
  )
  mocks.rows.mockImplementation(
    async (_index, first: number, last: number) =>
      new Map(
        Array.from({ length: last - first + 1 }, (_, offset) => [
          first + offset,
          [String(first + offset + 1)]
        ])
      )
  )
  const file = {
    readArgs: { settings: null, filePath: '/repo/a.csv' },
    snapshot: { size: 80, mtime: 1, isDirectory: false }
  }
  const { result } = renderHook(() => useCsvPagedPreview(file, ','))
  await waitFor(() => expect(result.current.index?.rowCount).toBe(16))
  act(() => {
    result.current.onVisibleRows(3, 5)
    result.current.onVisibleRows(8, 9)
    result.current.onVisibleRows(13, 14)
  })
  await waitFor(() => expect(result.current.getRow(14)).toEqual(['15']))
  expect(result.current.getRow(0)).toBeUndefined()
  expect(result.current.rows.size).toBe(2)
  expect(mocks.rows).toHaveBeenCalledTimes(2)
  expect(mocks.page).toHaveBeenCalledTimes(1)
})
