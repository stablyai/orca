import { expect, it } from 'vitest'
import {
  getWorktreeSymlinkPathFilterState,
  WORKTREE_SYMLINK_PATH_MAX_SUGGESTIONS
} from './worktree-symlink-path-filter'

it.each([100, 1_000, 50_000])('bounds matching name reads across %i entries', (size) => {
  let nameReads = 0
  const suggestions = Array.from({ length: size }, (_, index) => ({
    get name() {
      nameReads++
      return `package-${index}`
    },
    isDirectory: true
  }))
  const result = getWorktreeSymlinkPathFilterState({
    query: 'package',
    suggestions,
    existingPaths: []
  })
  expect(result.filtered).toHaveLength(WORKTREE_SYMLINK_PATH_MAX_SUGGESTIONS)
  expect(nameReads).toBe(WORKTREE_SYMLINK_PATH_MAX_SUGGESTIONS * 2)
  expect(result.filtered[0]).toBe(suggestions[0])
  expect(result.filtered.at(-1)).toBe(suggestions[49])
  expect(result.showLiteralItem).toBe(true)
})
