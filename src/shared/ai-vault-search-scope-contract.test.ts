import { describe, expect, it } from 'vitest'
import { AiVaultSearchRequestSchema, AiVaultSearchResponseSchema } from './ai-vault-search-contract'
import { searchResults } from './ai-vault-search-test-fixture'

describe('scope identity on the search request', () => {
  it('accepts a workspace identity', () => {
    expect(
      AiVaultSearchRequestSchema.parse({
        query: 'needle',
        within: { kind: 'workspace', worktreeId: 'repo-1::/work/app' }
      }).within
    ).toEqual({ kind: 'workspace', worktreeId: 'repo-1::/work/app' })
  })

  it('accepts a project identity under either key spelling', () => {
    for (const projectKey of ['repo:repo-1', 'project:proj-1']) {
      expect(
        AiVaultSearchRequestSchema.parse({
          query: 'needle',
          within: { kind: 'project', projectKey }
        }).within
      ).toEqual({ kind: 'project', projectKey })
    }
  })

  it('refuses an identity sent alongside explicit scope paths', () => {
    expect(() =>
      AiVaultSearchRequestSchema.parse({
        query: 'needle',
        within: { kind: 'project', projectKey: 'repo:repo-1' },
        filters: { scopePaths: ['/work/app'] }
      })
    ).toThrow(/either a scope identity or explicit scope paths/)
  })

  it('still accepts explicit scope paths with no identity, which is what --path sends', () => {
    expect(
      AiVaultSearchRequestSchema.parse({ query: 'needle', filters: { scopePaths: ['/work/app'] } })
        .filters
    ).toEqual({ scopePaths: ['/work/app'] })
  })

  it('still accepts the old shape that carries neither', () => {
    expect(AiVaultSearchRequestSchema.parse({ query: 'needle' })).toEqual({
      query: 'needle',
      limit: 20
    })
  })

  it('refuses an unknown identity kind rather than dropping the narrowing', () => {
    expect(() =>
      AiVaultSearchRequestSchema.parse({ query: 'needle', within: { kind: 'repo', repoId: 'r' } })
    ).toThrow()
  })

  it('carries the scope-unknown answer and per-host outcome on the response', () => {
    expect(
      AiVaultSearchResponseSchema.parse({ kind: 'unavailable', reason: 'scope-unknown' })
    ).toEqual({ kind: 'unavailable', reason: 'scope-unknown' })
    const hosts = [{ executionHostId: 'local', outcome: 'scope-unknown' }]
    expect(AiVaultSearchResponseSchema.parse({ ...searchResults(), hosts })).toMatchObject({
      hosts
    })
  })
})
