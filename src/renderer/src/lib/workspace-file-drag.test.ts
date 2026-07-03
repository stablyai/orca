import { describe, expect, it, vi } from 'vitest'

import * as crossPlatformPath from '../../../shared/cross-platform-path'
import {
  WORKSPACE_FILE_PATHS_MIME,
  WORKSPACE_FILE_PATH_MIME,
  encodeWorkspaceFilePaths,
  readWorkspaceFileDragPaths
} from './workspace-file-drag'

vi.mock('../../../shared/cross-platform-path', async (importOriginal) => {
  const actual = await importOriginal<typeof crossPlatformPath>()
  return {
    ...actual,
    normalizeRuntimePathForComparison: vi.fn(actual.normalizeRuntimePathForComparison)
  }
})

class FakeDataTransfer {
  private readonly data = new Map<string, string>()

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }

  setData(type: string, value: string): void {
    this.data.set(type, value)
  }
}

describe('workspace file drag payloads', () => {
  it('round-trips bounded multi-path payloads and removes nested duplicates', () => {
    const transfer = new FakeDataTransfer()
    transfer.setData(
      WORKSPACE_FILE_PATHS_MIME,
      encodeWorkspaceFilePaths(['/repo/src', '/repo/src/index.ts', '/repo/README.md'])
    )

    expect(readWorkspaceFileDragPaths(transfer)).toEqual({
      byteLength: 42,
      pathCount: 2,
      paths: ['/repo/src', '/repo/README.md'],
      status: 'accepted'
    })
  })

  it('keeps sibling paths whose names only share a prefix', () => {
    const transfer = new FakeDataTransfer()
    transfer.setData(
      WORKSPACE_FILE_PATHS_MIME,
      encodeWorkspaceFilePaths(['/repo/src', '/repo/src-other', '/repo/src-other/index.ts'])
    )

    const result = readWorkspaceFileDragPaths(transfer)

    expect(result).toMatchObject({
      pathCount: 2,
      paths: ['/repo/src', '/repo/src-other'],
      status: 'accepted'
    })
  })

  it('normalizes each accepted path once while pruning Windows-style nested duplicates', () => {
    const normalizePathForComparison = vi.mocked(
      crossPlatformPath.normalizeRuntimePathForComparison
    )
    normalizePathForComparison.mockClear()
    const transfer = new FakeDataTransfer()
    const paths = [
      'C:\\Repo\\src',
      'c:/repo/src/index.ts',
      'C:/Repo/src/components/Button.tsx',
      'C:/Repo/src-other/file.ts',
      'C:/Repo/src-other/file.ts'
    ]
    transfer.setData(WORKSPACE_FILE_PATHS_MIME, encodeWorkspaceFilePaths(paths))

    const result = readWorkspaceFileDragPaths(transfer)

    expect(result).toMatchObject({
      pathCount: 2,
      paths: ['C:\\Repo\\src', 'C:/Repo/src-other/file.ts'],
      status: 'accepted'
    })
    expect(normalizePathForComparison).toHaveBeenCalledTimes(paths.length)
  })

  it('rejects oversized raw multi-path data before JSON parsing', () => {
    const transfer = new FakeDataTransfer()
    const oversizedPrefix = '😀'.repeat(3)
    transfer.setData(WORKSPACE_FILE_PATHS_MIME, `${oversizedPrefix}not-json`)

    expect(readWorkspaceFileDragPaths(transfer, { maxPathBytes: 5 })).toEqual({
      byteLength: 8,
      pathCount: 0,
      reason: 'paths-too-large',
      status: 'rejected'
    })
  })

  it('rejects decoded path lists by path count without falling back to a single path', () => {
    const transfer = new FakeDataTransfer()
    transfer.setData(WORKSPACE_FILE_PATHS_MIME, JSON.stringify(['/repo/a', '/repo/b']))
    transfer.setData(WORKSPACE_FILE_PATH_MIME, '/repo/fallback')

    const filterSpy = vi.spyOn(Array.prototype, 'filter')
    const result = readWorkspaceFileDragPaths(transfer, { maxPaths: 1 })
    const filterCallCount = filterSpy.mock.calls.length
    filterSpy.mockRestore()

    expect(result).toEqual({
      byteLength: 0,
      pathCount: 2,
      reason: 'too-many-paths',
      status: 'rejected'
    })
    expect(filterCallCount).toBe(0)
  })
})
