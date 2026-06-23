import { describe, expect, it } from 'vitest'
import {
  decodeWorkspaceFilePaths,
  encodeWorkspaceFilePaths,
  getWorkspaceFileDragRejectionMessage,
  getWorkspaceFileDragPaths,
  readWorkspaceFileDragPaths,
  WORKSPACE_FILE_PATH_MIME,
  WORKSPACE_FILE_PATHS_MIME
} from '@/lib/workspace-file-drag'

describe('encodeWorkspaceFilePaths / decodeWorkspaceFilePaths', () => {
  it('encodes and decodes a single path as a plain string', () => {
    const encoded = encodeWorkspaceFilePaths(['/repo/a.ts'])
    expect(encoded).toBe('/repo/a.ts')
    expect(decodeWorkspaceFilePaths(encoded)).toEqual(['/repo/a.ts'])
  })

  it('encodes and decodes multiple paths as a JSON array', () => {
    const paths = ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']
    const encoded = encodeWorkspaceFilePaths(paths)
    expect(decodeWorkspaceFilePaths(encoded)).toEqual(paths)
  })

  it('round-trips any number of paths correctly', () => {
    const paths = ['/a', '/b', '/c', '/d', '/e']
    expect(decodeWorkspaceFilePaths(encodeWorkspaceFilePaths(paths))).toEqual(paths)
  })
})

describe('decodeWorkspaceFilePaths', () => {
  it('returns empty array for an empty string', () => {
    expect(decodeWorkspaceFilePaths('')).toEqual([])
  })

  it('returns the plain string wrapped in an array when not JSON', () => {
    expect(decodeWorkspaceFilePaths('/repo/a.ts')).toEqual(['/repo/a.ts'])
  })

  it('filters out non-string entries from a JSON array', () => {
    expect(decodeWorkspaceFilePaths(JSON.stringify(['/repo/a.ts', 42, null]))).toEqual([
      '/repo/a.ts'
    ])
  })
})

describe('getWorkspaceFileDragPaths', () => {
  it('falls back to the legacy single-path MIME', () => {
    expect(
      getWorkspaceFileDragPaths({
        getData: (type) => (type === WORKSPACE_FILE_PATH_MIME ? '/repo/a.ts' : '')
      })
    ).toEqual(['/repo/a.ts'])
  })

  it('prefers the multi-path MIME when present', () => {
    const paths = ['/repo/a.ts', '/repo/b.ts']
    expect(
      getWorkspaceFileDragPaths({
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME
            ? encodeWorkspaceFilePaths(paths)
            : type === WORKSPACE_FILE_PATH_MIME
              ? '/repo/a.ts'
              : ''
      })
    ).toEqual(paths)
  })

  it('drops selected descendants so moving a folder does not also move its children', () => {
    const paths = ['/repo/src', '/repo/src/components/Button.tsx', '/repo/src-extra/index.ts']
    expect(
      getWorkspaceFileDragPaths({
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME ? encodeWorkspaceFilePaths(paths) : ''
      })
    ).toEqual(['/repo/src', '/repo/src-extra/index.ts'])
  })

  it('drops selected descendants with Windows separators and case', () => {
    const paths = ['C:\\Repo\\src', 'c:\\repo\\src\\components\\Button.tsx']
    expect(
      getWorkspaceFileDragPaths({
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME ? encodeWorkspaceFilePaths(paths) : ''
      })
    ).toEqual(['C:\\Repo\\src'])
  })

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

  it('rejects too many internal paths before top-level descendant normalization', () => {
    const result = readWorkspaceFileDragPaths(
      {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME
            ? encodeWorkspaceFilePaths(['/repo/src', '/repo/src/Button.tsx'])
            : ''
      },
      { maxPaths: 1 }
    )

    expect(result).toEqual({
      byteLength: 0,
      pathCount: 2,
      reason: 'too-many-paths',
      status: 'rejected'
    })
  })

  it('returns redacted user-facing messages for bounded internal drag rejection', () => {
    expect(getWorkspaceFileDragRejectionMessage('too-many-paths')).toBe(
      'Drop contains too many paths.'
    )
    expect(getWorkspaceFileDragRejectionMessage('paths-too-large')).toBe(
      'Drop path list is too large.'
    )
  })
})
