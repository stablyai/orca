import { describe, expect, it } from 'vitest'
import {
  WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES,
  getWorktreeSymlinkPathFilterState,
  isWorktreeSymlinkPathQueryTooLarge,
  type WorktreeSymlinkPathSuggestion
} from './worktree-symlink-path-filter'

describe('worktree-symlink-path-filter', () => {
  it('filters suggestions by normalized path text and caps visible results', () => {
    const suggestions = [
      { name: 'node_modules', isDirectory: true },
      { name: 'packages/app', isDirectory: true },
      { name: 'packages/api', isDirectory: true },
      { name: '.env', isDirectory: false }
    ]

    expect(
      getWorktreeSymlinkPathFilterState({
        query: '/packages',
        suggestions,
        existingPaths: [],
        maxSuggestions: 1
      })
    ).toEqual({
      queryTrimmed: 'packages',
      filtered: [{ name: 'packages/app', isDirectory: true }],
      showLiteralItem: true,
      isQueryTooLarge: false
    })
  })

  it('hides the literal item when the query already exists', () => {
    expect(
      getWorktreeSymlinkPathFilterState({
        query: 'node_modules',
        suggestions: [{ name: 'node_modules', isDirectory: true }],
        existingPaths: ['node_modules']
      }).showLiteralItem
    ).toBe(false)
  })

  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES)

    expect(query.length).toBe(WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES)
    expect(isWorktreeSymlinkPathQueryTooLarge(query)).toBe(true)
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

    expect(isWorktreeSymlinkPathQueryTooLarge(oversizedQuery)).toBe(true)
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
