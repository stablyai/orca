import { describe, expect, it } from 'vitest'
import { parseVaultQuery } from './ai-vault-session-filters'
import {
  hasAiVaultSearchQueryOperators,
  splitAiVaultSearchQuery
} from './ai-vault-search-query-operators'

describe('what counts as an operator', () => {
  it('splits repo: and path: out of the free text', () => {
    const split = splitAiVaultSearchQuery('relay capacity repo:orca path:/work/app')
    expect(split.text).toBe('relay capacity')
    expect(split.terms).toEqual(['relay', 'capacity'])
    expect(split.repoTerms).toEqual(['orca'])
    expect(split.pathTerms).toEqual(['/work/app'])
    expect(hasAiVaultSearchQueryOperators(split)).toBe(true)
  })

  it('keeps a value that only looks like an operator as ordinary text', () => {
    const split = splitAiVaultSearchQuery('myrepo:x https://host/path:y')
    expect(split.repoTerms).toEqual([])
    expect(split.pathTerms).toEqual([])
    expect(split.text).toBe('myrepo:x https://host/path:y')
  })

  it('reads a quoted operator value whole, including its spaces', () => {
    expect(splitAiVaultSearchQuery('path:"/Users/ada/My Project" needle').pathTerms).toEqual([
      '/Users/ada/My Project'
    ])
  })

  it('does not let an apostrophe in prose swallow the operator between quotes', () => {
    const split = splitAiVaultSearchQuery("it's a repo:orca thing's")
    expect(split.repoTerms).toEqual(['orca'])
  })

  it('preserves operator case, which the panel folds and the index must not', () => {
    // cwd_key keeps execution-host case, so folding here would lose a POSIX
    // directory whose name differs only in case.
    expect(splitAiVaultSearchQuery('path:/Work/App').pathTerms).toEqual(['/Work/App'])
    expect(parseVaultQuery('path:/Work/App').pathTerms).toEqual(['/work/app'])
  })

  it('has no operators when the query is plain text', () => {
    expect(hasAiVaultSearchQueryOperators(splitAiVaultSearchQuery('relay capacity'))).toBe(false)
  })
})

// The panel parses through this module now, so the two cannot disagree by
// construction. What is worth pinning is the handful of shapes where the
// panel's old hand-rolled tokenizer answered differently, so the change of
// behaviour is a decision on the record rather than a surprise.
describe('the shapes where the panel parser used to answer differently', () => {
  it.each([
    ['repo:"" x', 'repoTerms'],
    ['path:"" x', 'pathTerms']
  ] as const)('drops the empty operator value in %s instead of filtering on `""`', (query, key) => {
    // The old tokenizer kept the quote characters as the value, so `repo:""`
    // filtered on a label no session has and silently emptied the list. An
    // operator with nothing in it is not a narrowing.
    expect(splitAiVaultSearchQuery(query)[key]).toEqual([])
    expect(parseVaultQuery(query)[key]).toEqual([])
  })

  it.each([
    ['repo:"  " x', 'repoTerms'],
    ['path:"  " x', 'pathTerms']
  ] as const)('drops the whitespace-only operator value in %s too', (query, key) => {
    // Same defect as `repo:""` wearing a different hat: an untrimmed `"  "`
    // survives as a term, matches no label, and empties the list.
    expect(splitAiVaultSearchQuery(query)[key]).toEqual([])
    expect(parseVaultQuery(query)[key]).toEqual([])
  })

  it('trims a quoted operator value rather than searching for the spaces', () => {
    expect(splitAiVaultSearchQuery('repo:" session-search "').repoTerms).toEqual(['session-search'])
  })

  it.each(['"" empty', "'' empty", '"  " empty'])(
    'reads the empty quotes in %s as an empty term',
    (query) => {
      // Same reason one level up: the old parser searched for the two characters
      // and found nothing, where an empty term matches everything and leaves the
      // rest of the query to do the work.
      expect(parseVaultQuery(query).terms).toEqual(['', 'empty'])
    }
  )

  it.each([
    ['"foo"bar', { terms: ['foo', 'bar'], repoTerms: [], pathTerms: [] }],
    ['"a b"c', { terms: ['a b', 'c'], repoTerms: [], pathTerms: [] }],
    ['repo:"a"b', { terms: ['b'], repoTerms: ['a'], pathTerms: [] }],
    ['path:"a"b', { terms: ['b'], repoTerms: [], pathTerms: ['a'] }],
    ['repo:"a b"c d', { terms: ['c', 'd'], repoTerms: ['a b'], pathTerms: [] }]
  ])('reads %s exactly as the panel always has', (query, expected) => {
    // A closing quote does not have to end a word. Requiring it turned each of
    // these into one term carrying its own quote characters, which matches
    // nothing; the apostrophe case below is protected by the token start, not
    // by that rule.
    expect(parseVaultQuery(query)).toEqual(expected)
  })
})

describe('agrees with the sessions panel parser on operator recognition', () => {
  it.each([
    'relay capacity',
    'repo:orca needle',
    'path:/work/app needle',
    'myrepo:x',
    'needle repo:orca path:/work/app',
    'path:"/Users/ada/My Project"',
    'https://host/path:y'
  ])('reads the same operators out of %s', (query) => {
    const split = splitAiVaultSearchQuery(query)
    const parsed = parseVaultQuery(query)
    const fold = (values: readonly string[]): string[] => values.map((v) => v.toLowerCase()).sort()
    expect(fold(split.repoTerms)).toEqual(fold(parsed.repoTerms))
    expect(fold(split.pathTerms)).toEqual(fold(parsed.pathTerms))
  })
})
