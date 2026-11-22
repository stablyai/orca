import { describe, expect, it, vi } from 'vitest'
import { createSessionSearchClient, unavailableSessionSearchStatus } from './ai-vault-search-client'
import { AiVaultSearchRequestSchema as LegacyRequestSchema } from '../../__fixtures__/pre-qoder-search-request'
import { searchResults } from './ai-vault-search-test-fixture'

describe.each(['qoder', 'jcode'] as const)('%s search negotiation', (agent) => {
  it.each(['runtime', 'relay'] as const)(
    'retains the supported filters through the actual old enum over %s',
    async (transport) => {
      const request = {
        query: 'q',
        scope: 'conversation' as const,
        limit: 42,
        cursor: 'page-1',
        debug: true,
        filters: {
          agents: [agent, 'codex', 'claude'] as const,
          scopePaths: ['/host/folder'],
          since: '2026-08-01T00:00:00.000Z',
          sort: 'newest' as const
        }
      }
      const search = vi.fn((params: unknown) => {
        expect(LegacyRequestSchema.parse(params)).toEqual({
          ...request,
          filters: { ...request.filters, agents: ['codex', 'claude'] }
        })
        return searchResults()
      })
      const client = createSessionSearchClient(
        async (method, params) =>
          method === 'aiVault.searchStatus' ? unavailableSessionSearchStatus() : search(params),
        transport
      )
      await client.searchSessions({
        ...request,
        filters: { ...request.filters, agents: [...request.filters.agents] }
      })
      expect(search).toHaveBeenCalledTimes(1)
    }
  )
})

describe('explicit search host vocabulary', () => {
  it('uses an explicit host catalog before either historical capability', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'aiVault.searchStatus'
        ? {
            ...unavailableSessionSearchStatus(),
            supportedAgents: [],
            supportsQoderHistory: true,
            supportsJcodeHistory: true
          }
        : searchResults()
    )
    expect(
      await createSessionSearchClient(call, 'relay').searchSessions({
        query: 'q',
        filters: { agents: ['qoder', 'jcode'] }
      })
    ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })
})
