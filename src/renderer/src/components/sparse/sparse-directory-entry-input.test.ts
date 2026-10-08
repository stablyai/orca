import { describe, expect, it } from 'vitest'
import {
  addSparseDirectoryEntries,
  parseSparseDirectoryEntryInput
} from './sparse-directory-entry-input'

describe('parseSparseDirectoryEntryInput', () => {
  it('normalizes a single typed path', () => {
    expect(parseSparseDirectoryEntryInput('  apps\\web/ ')).toEqual({
      entries: ['apps/web'],
      error: null
    })
  })

  it('splits a multi-line paste and drops duplicates', () => {
    expect(parseSparseDirectoryEntryInput('apps/web\npackages/ui\napps/web').entries).toEqual([
      'apps/web',
      'packages/ui'
    ])
  })

  it('rejects absolute paths and parent segments', () => {
    expect(parseSparseDirectoryEntryInput('/Users/me/repo').error).toBeTruthy()
    expect(parseSparseDirectoryEntryInput('C:\\repo').error).toBeTruthy()
    expect(parseSparseDirectoryEntryInput('apps/../secrets').error).toBeTruthy()
    expect(parseSparseDirectoryEntryInput('.').error).toBeTruthy()
  })
})

describe('addSparseDirectoryEntries', () => {
  it('appends only new entries and preserves order', () => {
    expect(addSparseDirectoryEntries(['apps/web'], ['apps/web', 'packages/ui'])).toEqual([
      'apps/web',
      'packages/ui'
    ])
  })
})
