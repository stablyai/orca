import { describe, expect, it } from 'vitest'
import {
  WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES,
  getWorktreeSymlinkPathFilterState,
  type WorktreeSymlinkPathSuggestion
} from './worktree-symlink-path-filter'

describe('worktree-symlink-path-filter', () => {
  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES)

    expect(query.length).toBe(WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES)
    expect(
      getWorktreeSymlinkPathFilterState({
        query,
        suggestions: [{ name: 'node_modules', isDirectory: true }],
        existingPaths: []
      })
    ).toEqual({
      queryTrimmed: '',
      filtered: [],
      showLiteralItem: false,
      isQueryTooLarge: true
    })
  })

  it('rejects oversized pasted path queries before reading suggestion names', () => {
    const oversizedQuery = 'secret-symlink-path'.repeat(WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES)
    const suggestions = [
      {
        get name(): string {
          throw new Error('oversized symlink path filters must not scan suggestion names')
        },
        isDirectory: true
      }
    ] as WorktreeSymlinkPathSuggestion[]

    expect(
      getWorktreeSymlinkPathFilterState({
        query: oversizedQuery,
        suggestions,
        existingPaths: []
      })
    ).toEqual({
      queryTrimmed: '',
      filtered: [],
      showLiteralItem: false,
      isQueryTooLarge: true
    })
  })
})
