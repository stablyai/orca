import { describe, expect, it } from 'vitest'
import {
  assertFilesystemDirectoryWithinLimit,
  createFilesystemDirectoryLimitState,
  FILESYSTEM_DIRECTORY_LIMIT_MESSAGE,
  FILESYSTEM_DIRECTORY_MAX_ENTRIES,
  FILESYSTEM_DIRECTORY_MAX_RETAINED_BYTES,
  resolveFilesystemDirectoryListingLimits,
  trackFilesystemDirectoryEntry
} from './filesystem-directory-listing-limit'

describe('filesystem directory listing limit', () => {
  it('accepts ordinary complete listings', () => {
    expect(() =>
      assertFilesystemDirectoryWithinLimit([
        { name: 'src' },
        { name: 'README.md' },
        { name: '文件.txt' }
      ])
    ).not.toThrow()
  })

  it('rejects the first entry beyond the count limit', () => {
    const state = createFilesystemDirectoryLimitState({
      maxEntries: 2,
      maxRetainedBytes: FILESYSTEM_DIRECTORY_MAX_RETAINED_BYTES
    })

    trackFilesystemDirectoryEntry(state, { name: 'one' })
    trackFilesystemDirectoryEntry(state, { name: 'two' })
    expect(() => trackFilesystemDirectoryEntry(state, { name: 'three' })).toThrow(
      FILESYSTEM_DIRECTORY_LIMIT_MESSAGE
    )
    expect(state.entries).toBe(3)
  })

  it('rejects names beyond the retained-byte limit', () => {
    const state = createFilesystemDirectoryLimitState({
      maxEntries: FILESYSTEM_DIRECTORY_MAX_ENTRIES,
      maxRetainedBytes: 100
    })

    expect(() => trackFilesystemDirectoryEntry(state, { name: 'xx' })).toThrow(
      FILESYSTEM_DIRECTORY_LIMIT_MESSAGE
    )
  })

  it('never lets callers raise the process-wide ceilings', () => {
    expect(
      resolveFilesystemDirectoryListingLimits({
        maxEntries: Number.MAX_SAFE_INTEGER,
        maxRetainedBytes: Number.MAX_SAFE_INTEGER
      })
    ).toEqual({
      maxEntries: FILESYSTEM_DIRECTORY_MAX_ENTRIES,
      maxRetainedBytes: FILESYSTEM_DIRECTORY_MAX_RETAINED_BYTES
    })
  })
})
