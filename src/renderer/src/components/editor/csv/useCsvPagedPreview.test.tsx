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
    readArgs: { target: { kind: 'local' as const }, filePath: '/repo/a.csv' },
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
