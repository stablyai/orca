import { describe, expect, it } from 'vitest'
import { splitAiVaultSearchQuery } from './ai-vault-search-query-operators'

describe('splitAiVaultSearchQuery', () => {
  it('sends plain text through untouched', () => {
    expect(splitAiVaultSearchQuery('strict mode violation')).toEqual({
      text: 'strict mode violation',
      terms: ['strict', 'mode', 'violation'],
      repoTerms: [],
      pathTerms: []
    })
  })

  it('strips repo:/path: terms from the server text and reports them', () => {
    const split = splitAiVaultSearchQuery('repo:orca flaky test path:/Users/ada/work')
    expect(split.text).toBe('flaky test')
    expect(split.repoTerms).toEqual(['orca'])
    expect(split.pathTerms).toEqual(['/Users/ada/work'])
  })

  it('keeps quoted operator values whole', () => {
    const split = splitAiVaultSearchQuery('path:"/Users/ada/My Project" retry')
    expect(split.text).toBe('retry')
    expect(split.pathTerms).toEqual(['/Users/ada/My Project'])
  })

  it('keeps a quoted free-text span whole and preserves its quotes for FTS', () => {
    const split = splitAiVaultSearchQuery('"resume picker" repo:orca')
    expect(split.text).toBe('"resume picker"')
    expect(split.terms).toEqual(['resume picker'])
  })

  it('reports empty text when only operators were typed', () => {
    expect(splitAiVaultSearchQuery('repo:orca').text).toBe('')
  })

  it('ignores an empty operator without treating the following word as its value', () => {
    const split = splitAiVaultSearchQuery('repo: orca')
    expect(split.repoTerms).toEqual([])
    expect(split.text).toBe('orca')
  })

  // A contraction's apostrophe used to open a quoted span that swallowed the operator.
  it('reads an operator between two contractions', () => {
    const split = splitAiVaultSearchQuery("it's a repo:orca thing's")
    expect(split.repoTerms).toEqual(['orca'])
    expect(split.text).toBe("it's a thing's")
  })

  // One rule everywhere: a quote groups only when it closes at a word boundary.
  // Inside an operator value, as in free text, one that does not is ordinary text.
  it('treats a quote that does not end a word as text inside an operator value', () => {
    const split = splitAiVaultSearchQuery('path:"a b"x')
    expect(split.pathTerms).toEqual(['"a'])
    expect(split.text).toBe('b"x')
  })

  // The operator ends at its first colon, so anything after it is the value.
  it('reads a second colon as part of the operator value', () => {
    expect(splitAiVaultSearchQuery('x repo::y')).toEqual({
      text: 'x',
      terms: ['x'],
      repoTerms: [':y'],
      pathTerms: []
    })
  })

  it('preserves operator value case so the path key decides folding', () => {
    expect(splitAiVaultSearchQuery('path:C:\\Work\\App needle').pathTerms).toEqual([
      'C:\\Work\\App'
    ])
    expect(splitAiVaultSearchQuery('repo:MyRepo').repoTerms).toEqual(['MyRepo'])
  })
})

it.each(['myrepo:orca', 'https://host/path:word', '"path:/literal phrase"', "don't"])(
  'preserves literal %s',
  (query) => {
    const split = splitAiVaultSearchQuery(query)
    expect(split.text).toBe(query)
    expect(split.repoTerms).toEqual([])
    expect(split.pathTerms).toEqual([])
  }
)
