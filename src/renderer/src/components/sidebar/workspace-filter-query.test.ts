import { describe, expect, it } from 'vitest'
import {
  getExplicitWorkspaceFilterKinds,
  getWorkspaceFilterAnyText,
  getWorkspaceFilterIdentityText,
  parseWorkspaceFilterQuery,
  tokenizeWorkspaceFilterQuery
} from './workspace-filter-query'

describe('tokenizeWorkspaceFilterQuery', () => {
  it('splits on whitespace and keeps quoted runs together', () => {
    expect(tokenizeWorkspaceFilterQuery('a  "b c" d:"e f"').map((t) => t.raw)).toEqual([
      'a',
      '"b c"',
      'd:"e f"'
    ])
  })

  it('records token offsets for caret lookups', () => {
    const [first, second] = tokenizeWorkspaceFilterQuery('host:mac  branch:x')
    expect(first).toEqual({ raw: 'host:mac', start: 0, end: 8 })
    expect(second).toEqual({ raw: 'branch:x', start: 10, end: 18 })
  })
})

describe('parseWorkspaceFilterQuery', () => {
  it('is inactive for blank input', () => {
    expect(parseWorkspaceFilterQuery('   ').isActive).toBe(false)
  })

  it('treats bare words and quoted phrases as free text', () => {
    const parsed = parseWorkspaceFilterQuery('orca "release notes"')
    expect(parsed.terms).toEqual([
      { text: 'orca', negated: false },
      { text: 'release notes', negated: false }
    ])
    expect(parsed.clauses).toEqual([])
  })

  it('parses qualifiers with aliases, comma OR lists, and negation', () => {
    const parsed = parseWorkspaceFilterQuery('hosts:Mac,ssh -b:main project:orca is:pinned')
    expect(parsed.clauses).toEqual([
      { key: 'host', values: ['mac', 'ssh'], negated: false },
      { key: 'branch', values: ['main'], negated: true },
      { key: 'repo', values: ['orca'], negated: false },
      { key: 'is', values: ['pinned'], negated: false }
    ])
  })

  it('keeps commas inside a quoted qualifier value literal', () => {
    expect(parseWorkspaceFilterQuery('branch:"a, b"').clauses[0]?.values).toEqual(['a, b'])
  })

  it('drops a qualifier that has no value yet so typing never blanks the list', () => {
    const parsed = parseWorkspaceFilterQuery('host:')
    expect(parsed.clauses).toEqual([])
    expect(parsed.isActive).toBe(false)
  })

  it('treats an unknown qualifier as free text', () => {
    expect(parseWorkspaceFilterQuery('foo:bar').terms).toEqual([
      { text: 'foo:bar', negated: false }
    ])
  })

  it('negates a bare word with a leading dash but keeps a lone dash as text', () => {
    expect(parseWorkspaceFilterQuery('-old -').terms).toEqual([
      { text: 'old', negated: true },
      { text: '-', negated: false }
    ])
  })
})

describe('query text projections', () => {
  it('joins positive terms for the identity search and any: values for the wide search', () => {
    const parsed = parseWorkspaceFilterQuery('orca -stale any:8080,review "two words"')
    expect(getWorkspaceFilterIdentityText(parsed)).toBe('orca two words')
    expect(getWorkspaceFilterAnyText(parsed)).toBe('8080 review')
  })

  it('collects explicit is: kinds and ignores negated or unknown ones', () => {
    const kinds = getExplicitWorkspaceFilterKinds(
      parseWorkspaceFilterQuery('is:sleeping,bogus -is:pinned is:main')
    )
    expect([...kinds].sort()).toEqual(['main', 'sleeping'])
  })
})
