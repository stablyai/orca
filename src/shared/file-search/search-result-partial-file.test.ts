import { expect, it } from 'vitest'
import { limitSearchResultToContentBudget } from './search-result-transport-budget'

it('keeps a usable prefix of a dense file within the serialized reply budget', () => {
  const matches = [1, 2, 3].map((line) => ({
    line,
    column: 1,
    matchLength: 3,
    lineContent: 'hit \u0001'.repeat(10)
  }))
  const result = limitSearchResultToContentBudget(
    {
      files: [{ filePath: '/work/dense.txt', relativePath: 'dense.txt', matches, matchCount: 3 }],
      totalMatches: 3,
      truncated: false
    },
    480
  )

  expect(
    result.files.map((file) => ({
      path: file.relativePath,
      lines: file.matches.map((match) => match.line),
      count: file.matchCount
    }))
  ).toEqual([{ path: 'dense.txt', lines: [1, 2], count: 2 }])
  expect(result.totalMatches).toBe(2)
  expect(result.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(480)
})
