import { describe, expect, it } from 'vitest'
import { isLikelyExplicitPathQuery, normalizeLiteralPathQuery } from './quick-open-literal-path'

describe('isLikelyExplicitPathQuery', () => {
  it('accepts rooted, tilde, relative, drive, and UNC shapes', () => {
    for (const query of [
      '/abs/path.ts',
      '~/notes.md',
      '~\\notes.md',
      './rel/file.ts',
      '../up/file.ts',
      'C:\\Users\\me\\file.txt',
      'C:/Users/me/file.txt',
      '\\\\server\\share\\file.ts'
    ]) {
      expect(isLikelyExplicitPathQuery(query), query).toBe(true)
    }
  })

  it('accepts any query containing a separator', () => {
    expect(isLikelyExplicitPathQuery('src/foo/bar.ts')).toBe(true)
    expect(isLikelyExplicitPathQuery('docs\\guide.md')).toBe(true)
    expect(isLikelyExplicitPathQuery('trailing/dir/')).toBe(true)
  })

  it('rejects bare names and empty queries', () => {
    expect(isLikelyExplicitPathQuery('auth.ts')).toBe(false)
    expect(isLikelyExplicitPathQuery('README')).toBe(false)
    expect(isLikelyExplicitPathQuery('  ')).toBe(false)
    expect(isLikelyExplicitPathQuery('')).toBe(false)
  })
})

describe('normalizeLiteralPathQuery', () => {
  it('keeps the path text and location for :line and :line:col suffixes', () => {
    expect(normalizeLiteralPathQuery('src/x.ts:42')).toEqual({
      pathText: 'src/x.ts',
      line: 42,
      column: null
    })
    expect(normalizeLiteralPathQuery('/repo/a/b.md:10:3')).toEqual({
      pathText: '/repo/a/b.md',
      line: 10,
      column: 3
    })
    expect(normalizeLiteralPathQuery('C:\\notes\\a.md:7')).toEqual({
      pathText: 'C:\\notes\\a.md',
      line: 7,
      column: null
    })
  })

  it('preserves trailing punctuation instead of trimming it', () => {
    expect(normalizeLiteralPathQuery('./notes.md.')).toEqual({
      pathText: './notes.md.',
      line: null,
      column: null
    })
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeLiteralPathQuery('  /tmp/a.txt  ')).toEqual({
      pathText: '/tmp/a.txt',
      line: null,
      column: null
    })
  })

  it('keeps trailing separators only on absolute or tilde shapes', () => {
    expect(normalizeLiteralPathQuery('/tmp/cache/')).toEqual({
      pathText: '/tmp/cache/',
      line: null,
      column: null
    })
    expect(normalizeLiteralPathQuery('src/components/')).toBeNull()
  })

  it('rejects non-path and prose-looking queries', () => {
    expect(normalizeLiteralPathQuery('auth.ts')).toBeNull()
    expect(normalizeLiteralPathQuery('/ foo/bar')).toBeNull()
    expect(normalizeLiteralPathQuery(':42')).toBeNull()
  })
})
