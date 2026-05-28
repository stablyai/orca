import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from './QuickOpen'

// fuzzyMatch receives pre-lowercased inputs (the component lowercases each path
// and the query once, rather than per-keystroke over the whole file list).
function match(query: string, path: string): number {
  const lower = path.toLowerCase()
  return fuzzyMatch(query.toLowerCase(), lower, lower.slice(lower.lastIndexOf('/') + 1))
}

describe('fuzzyMatch', () => {
  it('returns -1 when not all query characters appear in order', () => {
    expect(match('xyz', 'src/index.ts')).toBe(-1) // no y/z in the path
    expect(match('zzz', 'src/app.ts')).toBe(-1)
  })

  it('matches subsequences case-insensitively', () => {
    expect(match('IDX', 'src/index.ts')).not.toBe(-1)
    expect(match('appts', 'SRC/App.TS')).not.toBe(-1)
  })

  it('rewards a query that appears in the filename over a path-only match', () => {
    // 'app' is in the filename of the first, only in the dir of the second.
    const inFilename = match('app', 'src/app.ts')
    const inDirOnly = match('app', 'app/main.ts')
    expect(inFilename).toBeLessThan(inDirOnly)
  })

  it('ranks a contiguous filename match better than a scattered one', () => {
    const contiguous = match('index', 'src/index.ts')
    const scattered = match('index', 'i/n/d/e/x-other.ts')
    expect(contiguous).toBeLessThan(scattered)
  })
})
