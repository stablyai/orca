import { beforeEach, expect, it, vi } from 'vitest'
import { CSV_MAX_PAGE_BYTES } from './csv-byte-index'
import { CsvPagedPreview } from './csv-paged-preview'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn(), request: vi.fn(), close: vi.fn() }))
vi.mock('@/runtime/runtime-file-range-client', () => ({
  statRuntimeReadTarget: mocks.stat,
  readRuntimeFileRange: mocks.read
}))
vi.mock('./csv-preview-worker-client', () => ({
  CsvPreviewWorkerClient: class {
    request = mocks.request
    close = mocks.close
  }
}))

const snapshot = { size: 1024 * 1024, mtime: 1, isDirectory: false }
const file = { readArgs: { target: { kind: 'local' as const }, filePath: '/repo/a.csv' }, snapshot }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.stat.mockResolvedValue(snapshot)
  mocks.read.mockImplementation(async (_args, _offset, length: number) => new Uint8Array(length))
  mocks.request.mockResolvedValue({ kind: 'rows', rows: [['value']] })
})

it('caps the page count and evicts the least recently used one', async () => {
  const preview = new CsvPagedPreview(file)
  const range = (index: number) => ({
    start: index * 10,
    end: index * 10 + 10,
    firstRow: index,
    rowCount: 1
  })
  for (let index = 0; index < 64; index += 1) {
    await preview.page(index, range(index))
  }
  await preview.page(0, range(0))
  await preview.page(64, range(64))
  await preview.page(1, range(1))
  expect(mocks.read).toHaveBeenCalledTimes(66)
  preview.close()
})

it('detects changes even when a page is already cached', async () => {
  const preview = new CsvPagedPreview(file)
  const range = { start: 0, end: 10, firstRow: 0, rowCount: 1 }
  await preview.page(0, range)
  mocks.stat.mockResolvedValue({ ...snapshot, mtime: 2 })
  await expect(preview.page(0, range)).rejects.toThrow('changed on disk')
  expect(mocks.read).toHaveBeenCalledTimes(1)
  preview.close()
})

it('keeps a dense viewport cached when scrolling by one page', async () => {
  const preview = new CsvPagedPreview(file)
  mocks.request.mockResolvedValue({
    kind: 'rows',
    rows: Array.from({ length: 4 }, () => Array.from({ length: 4096 }, () => 'x'))
  })
  const range = (index: number) => ({
    start: index * 32768,
    end: (index + 1) * 32768,
    firstRow: index * 4,
    rowCount: 4
  })
  for (let index = 0; index < 16; index += 1) {
    await preview.page(index, range(index))
  }
  for (let index = 1; index <= 16; index += 1) {
    await preview.page(index, range(index))
  }
  expect(mocks.read).toHaveBeenCalledTimes(17)
  preview.close()
})

it('bounds cached cells independently of raw bytes and page count', async () => {
  const largeSnapshot = { ...snapshot, size: 2 * 1024 * 1024 }
  mocks.stat.mockResolvedValue(largeSnapshot)
  const preview = new CsvPagedPreview({ ...file, snapshot: largeSnapshot })
  mocks.request.mockResolvedValue({
    kind: 'rows',
    rows: Array.from({ length: 4 }, () => Array.from({ length: 4096 }, () => 'x'))
  })
  const range = (index: number) => ({
    start: index * 32768,
    end: (index + 1) * 32768,
    firstRow: index * 4,
    rowCount: 4
  })
  for (let index = 0; index < 33; index += 1) {
    await preview.page(index, range(index))
  }
  await preview.page(32, range(32))
  expect(mocks.read).toHaveBeenCalledTimes(33)
  await preview.page(0, range(0))
  expect(mocks.read).toHaveBeenCalledTimes(34)
  preview.close()
})

it('bounds cached raw bytes independently of cell count', async () => {
  const largeSnapshot = { ...snapshot, size: 10 * 1024 * 1024 }
  mocks.stat.mockResolvedValue(largeSnapshot)
  const preview = new CsvPagedPreview({ ...file, snapshot: largeSnapshot })
  const range = (index: number) => ({
    start: index * 1024 * 1024,
    end: (index + 1) * 1024 * 1024,
    firstRow: index,
    rowCount: 1
  })
  for (let index = 0; index < 9; index += 1) {
    await preview.page(index, range(index))
  }
  await preview.page(8, range(8))
  expect(mocks.request).toHaveBeenCalledTimes(9)
  await preview.page(0, range(0))
  expect(mocks.request).toHaveBeenCalledTimes(10)
  preview.close()
})

it('validates one viewport once before and after loading its pages, including cache hits', async () => {
  const preview = new CsvPagedPreview(file)
  const index = {
    pages: Array.from({ length: 16 }, (_, i) => ({
      start: i * 10,
      end: (i + 1) * 10,
      firstRow: i,
      rowCount: 1
    })),
    rowCount: 16,
    columnCount: 1
  }
  const rows = await preview.rows(index, 0, 14, () => false)
  expect(rows?.size).toBe(15)
  expect(mocks.stat).toHaveBeenCalledTimes(2)
  expect(mocks.read).toHaveBeenCalledTimes(15)
  mocks.stat.mockClear()
  await preview.rows(index, 0, 14, () => false)
  expect(mocks.stat).toHaveBeenCalledTimes(2)
  expect(mocks.read).toHaveBeenCalledTimes(15)
  mocks.stat.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ...snapshot, mtime: 2 })
  await expect(preview.rows(index, 0, 14, () => false)).rejects.toThrow('changed on disk')
  preview.close()
})

it('drops an abandoned viewport after its current page without starting more reads', async () => {
  const preview = new CsvPagedPreview(file)
  const index = {
    pages: Array.from({ length: 16 }, (_, i) => ({
      start: i * 10,
      end: (i + 1) * 10,
      firstRow: i,
      rowCount: 1
    })),
    rowCount: 16,
    columnCount: 1
  }
  let stale = false
  mocks.request.mockImplementation(async () => {
    stale = true
    return { kind: 'rows', rows: [['value']] }
  })
  await expect(preview.rows(index, 0, 14, () => stale)).resolves.toBeNull()
  expect(mocks.read).toHaveBeenCalledTimes(1)
  preview.close()
})

it('bounds reads, stops after cancellation, and rejects mismatched pages', async () => {
  const preview = new CsvPagedPreview(file)
  await preview.read(0, 1024 * 1024)
  expect(mocks.read.mock.calls.map((call) => call[2])).toEqual(
    Array.from({ length: 4 }, () => 256 * 1024)
  )
  await expect(preview.read(-1, 1)).rejects.toThrow('Invalid CSV page range')
  await expect(preview.page(0, { start: 0, end: 10, firstRow: 0, rowCount: 2 })).rejects.toThrow(
    'boundary mismatch'
  )
  preview.close()
  await expect(preview.read(0, 10)).rejects.toThrow('canceled')
  expect(mocks.close).toHaveBeenCalledTimes(1)
})

it('detects a mutation during the full scan before publishing an index', async () => {
  const preview = new CsvPagedPreview(file)
  mocks.request.mockResolvedValue({ kind: 'ack' })
  mocks.stat.mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, size: 20 })
  await expect(preview.buildIndex(',', () => {})).rejects.toThrow('changed on disk')
  expect(mocks.request.mock.calls.some(([command]) => command.kind === 'finish')).toBe(false)
  preview.close()
})

it('reads a maximum-size first record including its BOM and CRLF in bounded chunks', async () => {
  const largeSnapshot = { ...snapshot, size: CSV_MAX_PAGE_BYTES }
  mocks.stat.mockResolvedValue(largeSnapshot)
  const preview = new CsvPagedPreview({ ...file, snapshot: largeSnapshot })
  await preview.page(0, { start: 0, end: CSV_MAX_PAGE_BYTES, firstRow: 0, rowCount: 1 })
  expect(mocks.read.mock.calls.map((call) => call[2])).toEqual([
    256 * 1024,
    256 * 1024,
    256 * 1024,
    256 * 1024,
    5
  ])
  await expect(preview.read(0, CSV_MAX_PAGE_BYTES + 1)).rejects.toThrow('Invalid CSV page range')
  preview.close()
})
