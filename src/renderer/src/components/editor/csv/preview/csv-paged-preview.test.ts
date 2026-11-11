import { beforeEach, expect, it, vi } from 'vitest'
import { CsvPagedPreview } from './csv-paged-preview'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn(), request: vi.fn(), close: vi.fn() }))
vi.mock('@/runtime/files/reads/runtime-file-range-client', () => ({
  statRuntimeReadTarget: mocks.stat,
  readRuntimeFileRange: mocks.read
}))
vi.mock('./worker/csv-preview-worker-client', () => ({
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

it('detects a mutation during the full scan before publishing an index', async () => {
  const preview = new CsvPagedPreview(file)
  mocks.request.mockResolvedValue({ kind: 'ack' })
  mocks.stat.mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, size: 20 })
  await expect(preview.buildIndex(',', () => {})).rejects.toThrow('changed on disk')
  expect(mocks.request.mock.calls.some(([command]) => command.kind === 'finish')).toBe(false)
  preview.close()
})
