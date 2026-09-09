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

// Two parsers for one syntax exist only until the panel moves onto this one
// (PR 7). Until then they must agree on which token is an operator, or the same
// query means different things in the list and in the index.
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
