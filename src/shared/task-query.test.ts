import { describe, expect, it } from 'vitest'
import {
  parseTaskQuery,
  serializeTaskQuery,
  stripRepoQualifiers,
  tokenizeSearchQuery,
  withQualifier
} from './task-query'

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

  it('keeps quoted qualifier values as one token', () => {
    expect(tokenizeSearchQuery('label:"needs review" author:alice')).toEqual([
      'label:needs review',
      'author:alice'
    ])
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

  it('parses is:pull-request as a PR scope alias', () => {
    const parsed = parseTaskQuery('is:pull-request is:open')
    expect(parsed.scope).toBe('pr')
    expect(parsed.state).toBe('open')
  })

  it('widens scope to all when both is:issue and is:pr are present', () => {
    const parsed = parseTaskQuery('is:issue is:pr')
    expect(parsed.scope).toBe('all')
  })

  it('widens scope to all regardless of issue and PR token order', () => {
    const parsed = parseTaskQuery('is:pr is:issue')
    expect(parsed.scope).toBe('all')
  })

  it('is:draft forces scope to pr and state to open', () => {
    const parsed = parseTaskQuery('is:draft')
    expect(parsed.scope).toBe('pr')
    expect(parsed.state).toBe('open')
    expect(parsed.draft).toBe(true)
  })

  it('keeps draft scoped to open PRs even when a later token says issue', () => {
    const parsed = parseTaskQuery('is:draft is:issue')
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

  it('keeps review qualifiers scoped to PRs even when a later token says issue', () => {
    const parsed = parseTaskQuery('review-requested:@me is:issue')
    expect(parsed.scope).toBe('pr')
    expect(parsed.reviewRequested).toBe('@me')
  })

  it('leaves unknown qualifiers and bare words in freeText', () => {
    const parsed = parseTaskQuery('custom:value hello')
    expect(parsed.freeText).toBe('custom:value hello')
  })

  it('parses state:all for the Any state filter', () => {
    const parsed = parseTaskQuery('is:pr state:all')
    expect(parsed.scope).toBe('pr')
    expect(parsed.state).toBe('all')
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

describe('serializeTaskQuery', () => {
  it('round-trips qualifiers and free text', () => {
    const raw = 'is:pr is:open author:alice label:bug review-requested:bob hello world'
    const reserialized = serializeTaskQuery(parseTaskQuery(raw))
    expect(parseTaskQuery(reserialized)).toEqual(parseTaskQuery(raw))
  })

  it('quotes label values containing whitespace', () => {
    const parsed = parseTaskQuery('label:"needs review"')
    expect(parsed.labels).toEqual(['needs review'])
    expect(parsed.freeText).toBe('')
    expect(serializeTaskQuery(parsed)).toContain('label:"needs review"')
  })

  it('serializes all state so filter changes do not fall back to the default open state', () => {
    const raw = serializeTaskQuery(parseTaskQuery('is:pr state:all'))
    expect(raw).toBe('is:pr state:all')
  })
})

describe('withQualifier', () => {
  it('sets and clears the author qualifier without disturbing free text', () => {
    const set = withQualifier('hello', 'author', 'alice')
    expect(parseTaskQuery(set).author).toBe('alice')
    expect(parseTaskQuery(set).freeText).toBe('hello')
    const cleared = withQualifier(set, 'author', null)
    expect(parseTaskQuery(cleared).author).toBeNull()
    expect(parseTaskQuery(cleared).freeText).toBe('hello')
  })

  it('replaces the labels list', () => {
    const result = withQualifier('label:bug label:enh', 'labels', ['triage'])
    expect(parseTaskQuery(result).labels).toEqual(['triage'])
  })

  it('clears labels when given an empty array', () => {
    const result = withQualifier('label:bug is:pr', 'labels', [])
    expect(parseTaskQuery(result).labels).toEqual([])
    expect(parseTaskQuery(result).scope).toBe('pr')
  })

  it('sets the all state filter', () => {
    const result = withQualifier('is:pr is:open', 'state', 'all')
    expect(parseTaskQuery(result).state).toBe('all')
    expect(result).toContain('state:all')
  })

  it('preserves quoted free-text tokens when applying a filter', () => {
    const result = withQualifier('"exact phrase" milestone:"next release"', 'author', 'alice')
    expect(result).toContain('"exact phrase"')
    expect(result).toContain('milestone:"next release"')
    expect(parseTaskQuery(result).author).toBe('alice')
  })

  it('keeps PR-only filters scoped to PRs', () => {
    expect(parseTaskQuery(withQualifier('', 'draft', 'true')).scope).toBe('pr')
    expect(parseTaskQuery(withQualifier('', 'state', 'merged')).scope).toBe('pr')
    expect(parseTaskQuery(withQualifier('', 'reviewRequested', '@me')).scope).toBe('pr')
  })

  it('forces draft filters back to open PRs', () => {
    const parsed = parseTaskQuery(withQualifier('is:pr is:closed', 'draft', 'true'))
    expect(parsed.scope).toBe('pr')
    expect(parsed.state).toBe('open')
    expect(parsed.draft).toBe(true)
  })
})
