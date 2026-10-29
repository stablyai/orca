import { describe, expect, it } from 'vitest'
import type { SearchFileResult, SearchResult } from './code-search-types'
import { limitSearchResultToContentBudget } from './search-result-transport-budget'

function file(index: number, lineBytes: number): SearchFileResult {
  return {
    filePath: `/repo/src/file-${index}.ts`,
    relativePath: `src/file-${index}.ts`,
    matches: [{ line: 1, column: 1, matchLength: 3, lineContent: 'x'.repeat(lineBytes) }]
  }
}

function result(files: SearchFileResult[]): SearchResult {
  return { files, totalMatches: files.length, truncated: false }
}

describe('limitSearchResultToContentBudget', () => {
  it('leaves a result that fits, or an uncapped local one, as it is', () => {
    const small = result([file(1, 10)])
    expect(limitSearchResultToContentBudget(small, 64 * 1024)).toBe(small)
    const large = result(Array.from({ length: 200 }, (_, index) => file(index, 400)))
    expect(limitSearchResultToContentBudget(large, undefined)).toBe(large)
  })

  it('keeps whole files that fit the reply and marks the rest truncated', () => {
    const large = result(Array.from({ length: 200 }, (_, index) => file(index, 400)))
    const maxBytes = 16 * 1024
    const limited = limitSearchResultToContentBudget(large, maxBytes)

    expect(limited.truncated).toBe(true)
    expect(limited.files.length).toBeGreaterThan(0)
    expect(limited.files.length).toBeLessThan(200)
    expect(limited.files).toEqual(large.files.slice(0, limited.files.length))
    expect(limited.totalMatches).toBe(limited.files.length)
    expect(Buffer.byteLength(JSON.stringify(limited), 'utf8')).toBeLessThanOrEqual(maxBytes)
  })
})
