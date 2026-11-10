import { describe, expect, it } from 'vitest'
import { parseSparseDirectoryEntryInput } from './sparse-directory-entry-input'

describe('parseSparseDirectoryEntryInput', () => {
  it('rejects absolute paths and parent segments', () => {
    expect(parseSparseDirectoryEntryInput('/Users/me/repo').error).toBeTruthy()
    expect(parseSparseDirectoryEntryInput('C:\\repo').error).toBeTruthy()
    expect(parseSparseDirectoryEntryInput('apps/../secrets').error).toBeTruthy()
    expect(parseSparseDirectoryEntryInput('.').error).toBeTruthy()
  })
})
