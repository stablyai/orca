import { describe, expect, it } from 'vitest'
import {
  hasExplicitTaskScope,
  parseTaskQuery,
  serializeTaskQuery,
  stripRepoQualifiers,
  withQualifier
} from './task-query'

describe('hasExplicitTaskScope', () => {
  it('recognizes scope qualifiers and their quoted values', () => {
    for (const query of ['is:issue', 'IS:PR', 'is:pull-request', 'is:"pr"']) {
      expect(hasExplicitTaskScope(query)).toBe(true)
    }
  })

  it('keeps quoted phrases and values of other qualifiers as search text', () => {
    for (const query of ['"is:pr"', "'is:issue'", 'label:is:pr', 'title:"is:pull-request"']) {
      expect(hasExplicitTaskScope(query)).toBe(false)
      expect(parseTaskQuery(query).scope).toBe('all')
    }
  })
})

describe('parseTaskQuery', () => {
  it('widens scope to all when both is:issue and is:pr are present', () => {
    const parsed = parseTaskQuery('is:issue is:pr')
    expect(parsed.scope).toBe('all')
  })

  it('widens scope to all regardless of issue and PR token order', () => {
    const parsed = parseTaskQuery('is:pr is:issue')
    expect(parsed.scope).toBe('all')
  })

  it('keeps draft scoped to open PRs even when a later token says issue', () => {
    const parsed = parseTaskQuery('is:draft is:issue')
    expect(parsed.scope).toBe('pr')
    expect(parsed.state).toBe('open')
    expect(parsed.draft).toBe(true)
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
})

describe('stripRepoQualifiers', () => {
  it('removes repo:owner/name tokens', () => {
    expect(stripRepoQualifiers('is:open repo:foo/bar assignee:@me')).toBe('is:open assignee:@me')
  })

  it('re-quotes a standalone token that contains whitespace', () => {
    // Re-quote standalone phrases or serialization would split them into separate search tokens.
    const stripped = stripRepoQualifiers('"needs review" repo:x/y')
    expect(stripped).toBe('"needs review"')
  })
})

describe('serializeTaskQuery', () => {
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
