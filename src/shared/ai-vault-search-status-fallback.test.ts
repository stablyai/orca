import { describe, expect, it, vi } from 'vitest'
import { createSessionSearchClient, unavailableSessionSearchStatus } from './ai-vault-search-client'
import { AiVaultSearchRequestSchema as LegacyRequestSchema } from './__fixtures__/pre-qoder-search-request'
import { searchResults } from './ai-vault-search-test-fixture'

const query = {
  query: 'needle',
  scope: 'conversation' as const,
  limit: 7,
  cursor: 'next-page',
  filters: { agents: ['claude'] as const, scopePaths: ['/execution-host/folder'] }
}

describe.each(['runtime', 'relay'] as const)('missing search status over %s', (transport) => {
  it.each([-32601, 'method_not_found'])(
    'searches legacy filters after status refusal %s',
    async (code) => {
      const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'aiVault.searchStatus') {
          throw { code }
        }
        expect(LegacyRequestSchema.parse(params)).toEqual({
          ...query,
          filters: { ...query.filters, agents: ['claude'] }
        })
        return searchResults()
      })
      expect(
        await createSessionSearchClient(call, transport).searchSessions({
          ...query,
          filters: { ...query.filters, agents: ['claude'] }
        })
      ).toMatchObject({ kind: 'results' })
      expect(call.mock.calls.map(([method]) => method)).toEqual([
        'aiVault.searchStatus',
        'aiVault.searchSessions'
      ])
    }
  )

  it('keeps only the conservative legacy subset when status is absent', async () => {
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'aiVault.searchStatus') {
        throw { code: 'method_not_found' }
      }
      expect(LegacyRequestSchema.parse(params)).toEqual({
        ...query,
        filters: { ...query.filters, agents: ['claude'] }
      })
      return searchResults()
    })
    expect(
      await createSessionSearchClient(call, transport).searchSessions({
        ...query,
        filters: { ...query.filters, agents: ['jcode', 'qoder', 'codebuddy', 'zcode', 'claude'] }
      })
    ).toMatchObject({ kind: 'results' })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('does not dispatch an unsupported-only filter after status refusal', async () => {
    const call = vi.fn(async () => {
      throw { code: 'method_not_found' }
    })
    expect(
      await createSessionSearchClient(call, transport).searchSessions({
        query: 'needle',
        filters: { agents: ['jcode'] }
      })
    ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })

  it.each([{ supportedAgents: [] }, { supportedAgents: ['future-agent'] }])(
    'honors explicit narrow host vocabulary $supportedAgents',
    async ({ supportedAgents }) => {
      const call = vi.fn(async () => ({ ...unavailableSessionSearchStatus(), supportedAgents }))
      expect(
        await createSessionSearchClient(call, transport).searchSessions({
          query: 'needle',
          filters: { agents: ['claude'] }
        })
      ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
      expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
    }
  )

  it.each([
    { code: 'unauthorized', message: 'Authentication required' },
    { code: 'connection_closed', message: 'Host disconnected' },
    { code: -32000, message: 'Execution host refused request' }
  ])('propagates status failure $code without a search', async (error) => {
    const call = vi.fn(async () => {
      throw error
    })
    await expect(
      createSessionSearchClient(call, transport).searchSessions({
        query: 'needle',
        filters: { agents: ['claude'] }
      })
    ).rejects.toEqual(error)
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })

  it('propagates a malformed status instead of assuming a legacy host', async () => {
    const call = vi.fn(async () => ({ supportedAgents: ['claude'] }))
    await expect(
      createSessionSearchClient(call, transport).searchSessions({
        query: 'needle',
        filters: { agents: ['claude'] }
      })
    ).rejects.toThrow()
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })

  it('reports no service only when the search method itself is missing', async () => {
    const call = vi.fn(async () => {
      throw { code: 'method_not_found' }
    })
    expect(
      await createSessionSearchClient(call, transport).searchSessions({
        query: 'needle',
        filters: { agents: ['claude'] }
      })
    ).toEqual({ kind: 'unavailable', reason: 'no-service' })
    expect(call.mock.calls.map(() => true)).toHaveLength(2)
  })
})
