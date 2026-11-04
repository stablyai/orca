import { describe, expect, it } from 'vitest'
import { AiVaultSearchRequestSchema } from './ai-vault-search-contract'
import './ai-vault-search-test-fixture'

describe('scope identity on the search request', () => {
  it('refuses an identity sent alongside explicit scope paths', () => {
    expect(() =>
      AiVaultSearchRequestSchema.parse({
        query: 'needle',
        within: { kind: 'project', projectKey: 'repo:repo-1' },
        filters: { scopePaths: ['/work/app'] }
      })
    ).toThrow(/either a scope identity or explicit scope paths/)
  })

  it('refuses an unknown identity kind rather than dropping the narrowing', () => {
    expect(() =>
      AiVaultSearchRequestSchema.parse({ query: 'needle', within: { kind: 'repo', repoId: 'r' } })
    ).toThrow()
  })
})
