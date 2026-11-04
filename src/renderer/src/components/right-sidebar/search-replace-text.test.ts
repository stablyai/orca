import { describe, expect, it } from 'vitest'
import {
  buildCasePreservedReplacement,
  compileSearchReplace,
  previewLineReplacement,
  replaceInText,
  type CompiledSearchReplace,
  type SearchReplaceQuery,
  type SearchReplaceTarget
} from './search-replace-text'

function query(overrides: Partial<SearchReplaceQuery> & { query: string }): SearchReplaceQuery {
  return { caseSensitive: false, wholeWord: false, useRegex: false, ...overrides }
}

// Stands in for a search whose engine agrees with the JS regex on every line.
function searchTargets(content: string, compiled: CompiledSearchReplace): SearchReplaceTarget[] {
  return content.split('\n').flatMap((raw, index) =>
    [...raw.replace(/\r$/, '').matchAll(compiled.regex)].map((match) => ({
      line: index + 1,
      column: (match.index ?? 0) + 1,
      matchLength: match[0].length
    }))
  )
}

function replaceAll(content: string, compiled: CompiledSearchReplace) {
  return replaceInText(content, compiled, searchTargets(content, compiled))
}

describe('replaceInText', () => {
  it('replaces every literal match case-insensitively and keeps regex syntax literal', () => {
    const compiled = compileSearchReplace(query({ query: 'a.b' }), '$1x', false)
    expect(replaceAll('a.b A.B axb\na.b', compiled)).toEqual({
      content: '$1x $1x axb\n$1x',
      count: 3
    })
  })

  it('honors match case and whole word', () => {
    const compiled = compileSearchReplace(
      query({ query: 'foo', caseSensitive: true, wholeWord: true }),
      'bar',
      false
    )
    expect(replaceAll('foo Foo food foo_x é-foo', compiled)).toEqual({
      content: 'bar Foo food foo_x é-bar',
      count: 2
    })
  })

  it('expands capture groups, escapes, and case operators in regex mode', () => {
    const compiled = compileSearchReplace(
      query({ query: '(\\w+)=(\\w+)', useRegex: true }),
      '\\U$1\\t\\u$2$$\\n$&',
      false
    )
    expect(replaceAll('key=value', compiled).content).toBe('KEY\tValue$\nkey=value')
  })

  it('applies \\u and \\l to astral code points without splitting surrogate pairs', () => {
    const upper = compileSearchReplace(query({ query: '(\\S+)', useRegex: true }), '\\u$1', false)
    expect(replaceAll('𐐨abc', upper).content).toBe('𐐀abc')
    const lower = compileSearchReplace(query({ query: '(\\S+)', useRegex: true }), '\\l$1', false)
    expect(replaceAll('𐐀ABC', lower).content).toBe('𐐨ABC')
  })

  it('translates ripgrep \\z and \\A anchors instead of misreading them', () => {
    const end = compileSearchReplace(query({ query: 'foo\\z', useRegex: true }), 'bar', false)
    expect(replaceAll('foo\nfooz', end)).toEqual({ content: 'bar\nfooz', count: 1 })
    const start = compileSearchReplace(query({ query: '\\Afoo', useRegex: true }), 'bar', false)
    expect(replaceAll('foo\nxfoo', start)).toEqual({ content: 'bar\nxfoo', count: 1 })
  })

  it('leaves an escaped \\\\z literal alone', () => {
    const literal = compileSearchReplace(query({ query: '\\\\z', useRegex: true }), 'X', false)
    expect(replaceAll('a\\zb', literal)).toEqual({ content: 'aXb', count: 1 })
  })

  it('keeps matches on one line and preserves CRLF endings', () => {
    const compiled = compileSearchReplace(query({ query: 'a\\s+b', useRegex: true }), 'X', false)
    expect(replaceAll('a\r\nb a  b\r\n', compiled)).toEqual({
      content: 'a\r\nb X\r\n',
      count: 1
    })
  })

  it('replaces only the targeted match', () => {
    const compiled = compileSearchReplace(query({ query: 'x' }), 'y', false)
    expect(replaceInText('x x\nx x', compiled, [{ line: 2, column: 3, matchLength: 1 }])).toEqual({
      content: 'x x\nx y',
      count: 1
    })
    expect(replaceInText('x x', compiled, [{ line: 1, column: 2, matchLength: 1 }]).count).toBe(0)
  })

  it('skips a match whose extent differs from what the search reported', () => {
    // ripgrep's Unicode \w matched all of `café`; the JS regex only sees `caf`.
    const compiled = compileSearchReplace(query({ query: '[a-z]+', useRegex: true }), 'X', false)
    expect(replaceInText('café', compiled, [{ line: 1, column: 1, matchLength: 4 }])).toEqual({
      content: 'café',
      count: 0
    })
  })

  it('never removes or splits the \\r of a CRLF line', () => {
    const trailing = compileSearchReplace(query({ query: '\\s+$', useRegex: true }), '', false)
    expect(replaceAll('a  \r\nb\r\n', trailing).content).toBe('a\r\nb\r\n')
    const end = compileSearchReplace(query({ query: '$', useRegex: true }), ';', false)
    expect(replaceAll('a\r\nb', end).content).toBe('a;\r\nb;')
    const split = compileSearchReplace(query({ query: ',', useRegex: true }), '\\n', false)
    expect(replaceAll('a,b\r\n', split).content).toBe('a\r\nb\r\n')
  })

  it('terminates on zero-length matches', () => {
    const compiled = compileSearchReplace(query({ query: '^', useRegex: true }), '> ', false)
    expect(replaceAll('a\nb', compiled)).toEqual({ content: '> a\n> b', count: 2 })
  })
})

describe('buildCasePreservedReplacement', () => {
  it.each([
    ['FOO', 'bar', 'BAR'],
    ['foo', 'Bar', 'bar'],
    ['Foo', 'bar', 'Bar'],
    ['fOO', 'Bar', 'bar'],
    ['Foo-BAR', 'baz-qux', 'Baz-QUX'],
    ['foo_Bar', 'BAZ_qux', 'baz_Qux']
  ])('%s → %s gives %s', (matched, replacement, expected) => {
    expect(buildCasePreservedReplacement(matched, replacement)).toBe(expected)
  })

  it('applies to every match when enabled', () => {
    const compiled = compileSearchReplace(query({ query: 'foo' }), 'bar', true)
    expect(replaceAll('foo Foo FOO', compiled).content).toBe('bar Bar BAR')
  })

  it('preserves case for astral first characters', () => {
    expect(buildCasePreservedReplacement('𐐀abc', 'xyz')).toBe('Xyz')
    expect(buildCasePreservedReplacement('𐐨ABC', 'xyz')).toBe('xyz')
  })
})

describe('previewLineReplacement', () => {
  it('returns the replacement for the match at the column, or null', () => {
    const compiled = compileSearchReplace(query({ query: '(\\d+)', useRegex: true }), '#$1', false)
    expect(previewLineReplacement(compiled, 'a 12 b 34', 8, 2)).toBe('#34')
    expect(previewLineReplacement(compiled, 'a 12 b 34', 2, 1)).toBeNull()
    expect(previewLineReplacement(compiled, 'a 12 b 34', 3, 1)).toBeNull()
  })
})
