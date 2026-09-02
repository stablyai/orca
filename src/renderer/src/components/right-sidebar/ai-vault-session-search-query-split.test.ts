import { describe, expect, it } from 'vitest'
import {
  resolveAiVaultSearchScopePaths,
  splitAiVaultSearchQuery
} from './ai-vault-session-search-query-split'

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
    expect(split.pathTerms).toEqual(['/users/ada/work'])
  })

  it('keeps quoted operator values whole', () => {
    const split = splitAiVaultSearchQuery('path:"/Users/ada/My Project" retry')
    expect(split.text).toBe('retry')
    expect(split.pathTerms).toEqual(['/users/ada/my project'])
  })

  it('reports empty text when only operators were typed', () => {
    expect(splitAiVaultSearchQuery('repo:orca').text).toBe('')
  })

  it('leaves an operator with no value as plain text', () => {
    const split = splitAiVaultSearchQuery('repo: orca')
    expect(split.repoTerms).toEqual([])
    expect(split.text).toBe('orca')
  })
})

describe('resolveAiVaultSearchScopePaths', () => {
  const repos = [
    { id: 'r1', displayName: 'Orca', path: '/repos/orca' },
    { id: 'r2', displayName: 'Docs', path: '/repos/docs' }
  ]
  const worktrees = [
    { path: '/work/orca-a', repoId: 'r1' },
    { path: '/work/orca-b', repoId: 'r1' },
    { path: '/work/docs-a', repoId: 'r2' }
  ]

  it('expands a repo term to that repo and its worktrees', () => {
    expect(
      resolveAiVaultSearchScopePaths({ repoTerms: ['orca'], pathTerms: [] }, { repos, worktrees })
    ).toEqual(['/repos/orca', '/work/orca-a', '/work/orca-b'])
  })

  it('passes an absolute path term straight through', () => {
    expect(
      resolveAiVaultSearchScopePaths(
        { repoTerms: [], pathTerms: ['/somewhere/else'] },
        { repos, worktrees }
      )
    ).toEqual(['/somewhere/else'])
  })

  it('matches a relative path term against known worktrees', () => {
    expect(
      resolveAiVaultSearchScopePaths({ repoTerms: [], pathTerms: ['docs-a'] }, { repos, worktrees })
    ).toEqual(['/work/docs-a'])
  })

  it('resolves nothing when no repo or worktree matches', () => {
    expect(
      resolveAiVaultSearchScopePaths(
        { repoTerms: ['unknown'], pathTerms: ['nowhere'] },
        { repos, worktrees }
      )
    ).toEqual([])
  })
})
