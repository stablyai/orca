import { expect, it, vi } from 'vitest'
import { prepareQuickOpenFiles, rankQuickOpenFiles } from '../quick-open-search'
import { findExistingFileMatches } from './tab-create-entry-file-matches'
import type * as QuickOpenSearch from '../quick-open-search'

const ranking = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../quick-open-search', async (importOriginal) => {
  const original = await importOriginal<typeof QuickOpenSearch>()
  return {
    ...original,
    rankQuickOpenFiles: (...args: Parameters<typeof original.rankQuickOpenFiles>) => {
      ranking.calls++
      return original.rankQuickOpenFiles(...args)
    }
  }
})

it('skips fuzzy ranking when exact matches fill the requested window', () => {
  const files = prepareQuickOpenFiles(
    Array.from({ length: 10000 }, (_, index) => `${index}/readme.md`)
  )
  ranking.calls = 0
  const matches = findExistingFileMatches('readme.md', files, 10)
  expect(matches.map((match) => match.relativePath)).toEqual(
    files.slice(0, 10).map((file) => file.path)
  )
  expect(matches.every((match) => match.matchKind === 'exact-basename')).toBe(true)
  expect(ranking.calls).toBe(0)
})

it('deduplicates exact paths and still fills remaining slots with fuzzy matches', () => {
  const files = prepareQuickOpenFiles(['a.md', 'a.md', 'other/a.md', 'abc.md'])
  expect(findExistingFileMatches('a.md', files, 4)).toEqual([
    { kind: 'existing-file', matchKind: 'exact-path', relativePath: 'a.md' },
    { kind: 'existing-file', matchKind: 'exact-basename', relativePath: 'other/a.md' },
    { kind: 'existing-file', matchKind: 'fuzzy', relativePath: 'abc.md' }
  ])
})

// Why: skipping the ranker is only sound because a fuzzy hit can never outrank an
// exact one — exact results are concatenated first and dedupe is first-wins, so the
// exact prefix is exactly what a full ranked-then-sliced list would have returned.
// This re-runs the pre-skip pipeline and holds the shipped one to it.
function rankThenSlice(
  query: string,
  files: readonly QuickOpenSearch.QuickOpenIndexedFile[],
  limit: number
): { kind: string; matchKind: string; relativePath: string }[] {
  const normalized = query.trim().replace(/\\/g, '/')
  if (!normalized || limit <= 0) {
    return []
  }
  const lower = normalized.toLowerCase()
  const all = [
    ...files.filter((f) => f.lowerPath === lower).map((f) => ['exact-path', f.path] as const),
    ...files
      .filter((f) => f.lowerFilename === lower)
      .map((f) => ['exact-basename', f.path] as const),
    ...rankQuickOpenFiles(normalized, files, limit).map((f) => ['fuzzy', f.path] as const)
  ]
  const seen = new Set<string>()
  return all
    .filter(([, path]) => !seen.has(path) && (seen.add(path), true))
    .map(([matchKind, relativePath]) => ({ kind: 'existing-file', matchKind, relativePath }))
    .slice(0, limit)
}

it('returns what rank-then-slice would have returned, including at limit 1', () => {
  const corpus = [
    ['a.md', 'ab.md', 'abc.md', 'deep/nested/a.md'],
    ['ab.md', 'abc.md', 'deep/nested/a.md'],
    ['src/index.ts', 'src/app/index.ts', 'index.ts', 'indexer.ts'],
    ['a.md', 'a.md', 'other/a.md', 'abc.md'],
    ['README.md', 'docs/readme.md', 'readme.mdx'],
    ['only-fuzzy.md']
  ]
  const queries = ['a.md', 'index.ts', 'readme.md', 'src/index.ts', 'a', 'nope.md']
  for (const paths of corpus) {
    const files = prepareQuickOpenFiles(paths)
    for (const query of queries) {
      for (const limit of [0, 1, 2, 3, 5]) {
        expect({
          paths,
          query,
          limit,
          matches: findExistingFileMatches(query, files, limit)
        }).toEqual({ paths, query, limit, matches: rankThenSlice(query, files, limit) })
      }
    }
  }
})

it('takes the exact match at limit 1 without consulting the ranker at all', () => {
  const files = prepareQuickOpenFiles(['a.md', 'ab.md', 'abc.md', 'deep/nested/a.md'])
  ranking.calls = 0
  expect(findExistingFileMatches('a.md', files, 1)).toEqual([
    { kind: 'existing-file', matchKind: 'exact-path', relativePath: 'a.md' }
  ])
  expect(ranking.calls).toBe(0)
  const withoutExactPath = prepareQuickOpenFiles(['ab.md', 'abc.md', 'deep/nested/a.md'])
  ranking.calls = 0
  expect(findExistingFileMatches('a.md', withoutExactPath, 1)).toEqual([
    { kind: 'existing-file', matchKind: 'exact-basename', relativePath: 'deep/nested/a.md' }
  ])
  expect(ranking.calls).toBe(0)
})

it('ranks fuzzily whenever exact matches leave a slot open, and honours a zero limit', () => {
  const files = prepareQuickOpenFiles(['a.md', 'abc.md'])
  ranking.calls = 0
  expect(findExistingFileMatches('a.md', files, 2)).toEqual([
    { kind: 'existing-file', matchKind: 'exact-path', relativePath: 'a.md' },
    { kind: 'existing-file', matchKind: 'fuzzy', relativePath: 'abc.md' }
  ])
  expect(ranking.calls).toBe(1)
  ranking.calls = 0
  expect(findExistingFileMatches('a.md', files, 0)).toEqual([])
  expect(findExistingFileMatches('   ', files, 5)).toEqual([])
  expect(ranking.calls).toBe(0)
})
