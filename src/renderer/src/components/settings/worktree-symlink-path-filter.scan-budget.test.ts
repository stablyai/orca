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

it('keeps the stock filter and slice results, identities and literal choice', () => {
  const suggestions = Array.from({ length: 120 }, (_, index) => ({
    name: index % 3 === 0 ? `PACKAGE-${index}` : `other-${index}`,
    isDirectory: index % 2 === 0
  }))
  const limits = [0, 1, 5, 50, 500, -1, -5, 2.8, Number.NaN, Infinity, -Infinity]
  for (const query of ['', '  /package ', 'OTHER', 'PACKAGE-3', 'missing']) {
    const queryTrimmed = query.trim().replace(/^\/+/, '')
    const normalizedQuery = queryTrimmed.toLowerCase()
    for (const maxSuggestions of limits) {
      const filtered = (
        normalizedQuery
          ? suggestions.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery))
          : suggestions
      ).slice(0, maxSuggestions)
      const result = getWorktreeSymlinkPathFilterState({
        query,
        suggestions,
        existingPaths: ['missing'],
        maxSuggestions
      })
      expect(result).toEqual({
        queryTrimmed,
        filtered,
        showLiteralItem:
          queryTrimmed.length > 0 &&
          !filtered.some((entry) => entry.name === queryTrimmed) &&
          queryTrimmed !== 'missing',
        isQueryTooLarge: false
      })
      expect(result.filtered.every((entry, index) => entry === filtered[index])).toBe(true)
    }
  }
})

it('searches past nonmatches and preserves sparse-array filtering', () => {
  const suggestions = Array.from({ length: 1_000 }, (_, index) => ({
    name: index % 30 === 0 ? `target-${index}` : `other-${index}`,
    isDirectory: true
  }))
  delete suggestions[0]
  const result = getWorktreeSymlinkPathFilterState({
    query: 'target',
    suggestions,
    existingPaths: [],
    maxSuggestions: 5
  })
  expect(result.filtered).toEqual(
    suggestions.filter((entry) => entry.name.includes('target')).slice(0, 5)
  )
  expect(result.filtered.map((entry) => entry.name)).toEqual([
    'target-30',
    'target-60',
    'target-90',
    'target-120',
    'target-150'
  ])
})

it('does not inspect names when no suggestions can be returned', () => {
  const result = getWorktreeSymlinkPathFilterState({
    query: 'target',
    suggestions: [
      {
        get name(): string {
          throw new Error('a zero result budget must not inspect names')
        },
        isDirectory: true
      }
    ],
    existingPaths: [],
    maxSuggestions: 0
  })
  expect(result.filtered).toEqual([])
  expect(result.showLiteralItem).toBe(true)
})

it('retains the literal choice when an exact match falls after the visible limit', () => {
  const suggestions = Array.from({ length: 50 }, (_, index) => ({
    name: `target-${index}`,
    isDirectory: true
  }))
  suggestions.push({ name: 'target', isDirectory: true })
  expect(
    getWorktreeSymlinkPathFilterState({ query: 'target', suggestions, existingPaths: [] })
      .showLiteralItem
  ).toBe(true)
})
