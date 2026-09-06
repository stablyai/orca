import { describe, expect, it } from 'vitest'
import { splitAiVaultSearchQuery } from './ai-vault-search-query-operators'

describe('splitAiVaultSearchQuery', () => {
  it('sends plain text through untouched', () => {
    expect(splitAiVaultSearchQuery('strict mode violation')).toEqual({
      text: 'strict mode violation',
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

  it('reports empty text when only operators were typed', () => {
    expect(splitAiVaultSearchQuery('repo:orca').text).toBe('')
  })

  it('ignores an empty operator without treating the following word as its value', () => {
    const split = splitAiVaultSearchQuery('repo: orca')
    expect(split.repoTerms).toEqual([])
    expect(split.text).toBe('orca')
  })
})

it.each(['myrepo:orca', 'https://host/path:word', '"path:/literal phrase"'])(
  'preserves literal %s',
  (query) => {
    expect(splitAiVaultSearchQuery(query)).toEqual({ text: query, repoTerms: [], pathTerms: [] })
  }
)
