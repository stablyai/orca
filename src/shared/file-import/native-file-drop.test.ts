import { describe, expect, it } from 'vitest'
import {
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  createRejectedNativeFileDropPayload,
  hasNativeFileDragTypes,
  validateNativeFileDropPaths
} from './native-file-drop'

describe('hasNativeFileDragTypes', () => {
  it('rejects internal Orca file moves and URL/text drags', () => {
    expect(hasNativeFileDragTypes(['Files', ORCA_INTERNAL_FILE_DRAG_TYPE])).toBe(false)
    expect(hasNativeFileDragTypes(['text/uri-list'])).toBe(false)
    expect(hasNativeFileDragTypes(['text/plain'])).toBe(false)
  })
})

describe('validateNativeFileDropPaths', () => {
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

  it('rejects multibyte native path lists with bounded byte accounting', () => {
    expect(validateNativeFileDropPaths(['😀'.repeat(3)], { maxPathBytes: 5 })).toEqual({
      byteLength: 8,
      pathCount: 1,
      reason: 'paths-too-large',
      status: 'rejected'
    })
  })
})
