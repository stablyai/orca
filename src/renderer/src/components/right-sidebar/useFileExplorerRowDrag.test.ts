import { describe, expect, it } from 'vitest'
import {
  decodeWorkspaceFilePaths,
  getWorkspaceFileDragPaths,
  readWorkspaceFileDragPaths,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'

describe('decodeWorkspaceFilePaths', () => {
  it('filters out non-string entries from a JSON array', () => {
    expect(decodeWorkspaceFilePaths(JSON.stringify(['/repo/a.ts', 42, null]))).toEqual([
      '/repo/a.ts'
    ])
  })
})

describe('getWorkspaceFileDragPaths', () => {
  it('fails closed when the drag payload exceeds the bounded decoder limits', () => {
    const oversizedPath = `C:\\Users\\alice\\${'s'.repeat(260 * 1024)}`

    expect(
      getWorkspaceFileDragPaths({
        getData: (type) => (type === WORKSPACE_FILE_PATH_MIME ? oversizedPath : '')
      })
    ).toEqual([])
  })
})

describe('readWorkspaceFileDragPaths', () => {
  it('rejects raw path payloads before parsing or normalizing oversized data', () => {
    const result = readWorkspaceFileDragPaths(
      {
        getData: (type) => (type === WORKSPACE_FILE_PATH_MIME ? 'C:\\Users\\alice\\secret' : '')
      },
      { maxPathBytes: 4 }
    )

    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toBe('paths-too-large')
      expect(result.pathCount).toBe(0)
      expect(result.byteLength).toBeGreaterThan(4)
      expect(JSON.stringify(result)).not.toContain('alice')
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })
})
