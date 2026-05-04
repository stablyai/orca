import { describe, expect, it } from 'vitest'
import { parseTaskQuery, stripRepoQualifiers, tokenizeSearchQuery } from './task-query'

describe('tokenizeSearchQuery', () => {
  it('splits on whitespace', () => {
    expect(tokenizeSearchQuery('is:open assignee:@me foo')).toEqual([
      'is:open',
      'assignee:@me',
      'foo'
    ])
  })

  it('unwraps standalone double-quoted tokens', () => {
    expect(tokenizeSearchQuery('"needs review" foo')).toEqual(['needs review', 'foo'])
  })

  it('unwraps standalone single-quoted tokens', () => {
    expect(tokenizeSearchQuery("'with spaces' bar")).toEqual(['with spaces', 'bar'])
  })

  it('returns an empty list for an empty string', () => {
    expect(tokenizeSearchQuery('')).toEqual([])
  })
})

describe('parseTaskQuery', () => {
  it('returns defaults for an empty query', () => {
    const parsed = parseTaskQuery('')
    expect(parsed.scope).toBe('all')
    expect(parsed.state).toBeNull()
    expect(parsed.labels).toEqual([])
    expect(parsed.freeText).toBe('')
  })

  it('parses is:issue and is:open', () => {
    const parsed = parseTaskQuery('is:issue is:open')
    expect(parsed.scope).toBe('issue')
    expect(parsed.state).toBe('open')
  })

  it('widens scope to all when both is:issue and is:pr are present', () => {
    const parsed = parseTaskQuery('is:issue is:pr')
    expect(parsed.scope).toBe('all')
  })

  it('is:draft forces scope to pr and state to open', () => {
    const parsed = parseTaskQuery('is:draft')
    expect(parsed.scope).toBe('pr')
    expect(parsed.state).toBe('open')
    expect(parsed.draft).toBe(true)
  })

  it('is:pr is:open does not set draft', () => {
    const parsed = parseTaskQuery('is:pr is:open')
    expect(parsed.scope).toBe('pr')
    expect(parsed.state).toBe('open')
    expect(parsed.draft).toBe(false)
  })

  it('extracts assignee, author, label, and review qualifiers', () => {
    const parsed = parseTaskQuery(
      'assignee:@me author:alice review-requested:@me label:bug free text'
    )
    expect(parsed.assignee).toBe('@me')
    expect(parsed.author).toBe('alice')
    expect(parsed.reviewRequested).toBe('@me')
    expect(parsed.scope).toBe('pr') // review-requested forces pr
    expect(parsed.labels).toEqual(['bug'])
    expect(parsed.freeText).toBe('free text')
  })

  it('leaves unknown qualifiers and bare words in freeText', () => {
    const parsed = parseTaskQuery('custom:value hello')
    expect(parsed.freeText).toBe('custom:value hello')
  })
})

describe('stripRepoQualifiers', () => {
  it('removes repo:owner/name tokens', () => {
    expect(stripRepoQualifiers('is:open repo:foo/bar assignee:@me')).toBe('is:open assignee:@me')
  })

  it('is case-insensitive on the repo: key', () => {
    expect(stripRepoQualifiers('REPO:Foo/Bar is:open')).toBe('is:open')
  })

  it('keeps other qualifiers intact', () => {
    expect(stripRepoQualifiers('label:bug repo:a/b')).toBe('label:bug')
  })

  it('re-quotes a standalone token that contains whitespace', () => {
    // Standalone quoted tokens are unwrapped by the tokenizer; the stripper
    // re-wraps them in quotes so they still serialize as one token.
    const stripped = stripRepoQualifiers('"needs review" repo:x/y')
    expect(stripped).toBe('"needs review"')
  })

  it('returns empty string when only repo qualifiers are present', () => {
    expect(stripRepoQualifiers('repo:foo/bar repo:baz/qux')).toBe('')
  })

  it('preserves a bare word containing no space', () => {
    expect(stripRepoQualifiers('hello repo:a/b world')).toBe('hello world')
  })
})
