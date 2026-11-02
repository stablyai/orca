import { describe, expect, it } from 'vitest'
import {
  NATIVE_FILE_DROP_MAX_PATH_BYTES,
  NATIVE_FILE_DROP_MAX_PATHS,
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  createRejectedNativeFileDropPayload,
  hasNativeFileDragTypes,
  validateNativeFileDropPaths
} from './native-file-drop'

describe('hasNativeFileDragTypes', () => {
  it('accepts native OS file drags', () => {
    expect(hasNativeFileDragTypes(['Files'])).toBe(true)
  })

  it('rejects internal Orca file moves and URL/text drags', () => {
    expect(hasNativeFileDragTypes(['Files', ORCA_INTERNAL_FILE_DRAG_TYPE])).toBe(false)
    expect(hasNativeFileDragTypes(['text/uri-list'])).toBe(false)
    expect(hasNativeFileDragTypes(['text/plain'])).toBe(false)
  })
})

describe('validateNativeFileDropPaths', () => {
  it('rejects native drops by file count before path byte accounting is needed', () => {
    const paths = Array.from({ length: NATIVE_FILE_DROP_MAX_PATHS + 1 }, (_value, index) =>
      ['/tmp/file-', String(index)].join('')
    )

    expect(validateNativeFileDropPaths(paths)).toEqual({
      byteLength: 0,
      pathCount: NATIVE_FILE_DROP_MAX_PATHS + 1,
      reason: 'too-many-paths',
      status: 'rejected'
    })
  })

  it('rejects native drops whose path list is too large without exposing paths', () => {
    const validation = validateNativeFileDropPaths(['C:\\Users\\alice\\secret-token.txt'], {
      maxPathBytes: 4
    })

    expect(validation).toEqual({
      byteLength: 5,
      pathCount: 1,
      reason: 'paths-too-large',
      status: 'rejected'
    })
    if (validation.status === 'rejected') {
      const payload = createRejectedNativeFileDropPayload(validation)
      expect(JSON.stringify(payload)).not.toContain('secret')
      expect(JSON.stringify(payload)).not.toContain('alice')
    }
  })

  it('accepts path payloads within the configured limits', () => {
    expect(validateNativeFileDropPaths(['/tmp/a', '/tmp/b'])).toEqual({
      byteLength: 12,
      pathCount: 2,
      status: 'accepted'
    })
  })

  it('rejects multibyte native path lists with bounded byte accounting', () => {
    expect(validateNativeFileDropPaths(['😀'.repeat(3)], { maxPathBytes: 5 })).toEqual({
      byteLength: 8,
      pathCount: 1,
      reason: 'paths-too-large',
      status: 'rejected'
    })
  })

  it('enforces file count and byte limits at their boundaries', () => {
    expect(
      validateNativeFileDropPaths(Array.from({ length: NATIVE_FILE_DROP_MAX_PATHS }, () => '/a'))
        .status
    ).toBe('accepted')
    expect(
      validateNativeFileDropPaths(
        Array.from({ length: NATIVE_FILE_DROP_MAX_PATHS + 1 }, () => '/a')
      ).status
    ).toBe('rejected')
    expect(validateNativeFileDropPaths(['a'.repeat(NATIVE_FILE_DROP_MAX_PATH_BYTES)]).status).toBe(
      'accepted'
    )
    expect(
      validateNativeFileDropPaths(['a'.repeat(NATIVE_FILE_DROP_MAX_PATH_BYTES + 1)]).status
    ).toBe('rejected')
  })
})
