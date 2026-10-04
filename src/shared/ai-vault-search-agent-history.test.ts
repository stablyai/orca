import { describe, expect, it, vi } from 'vitest'
import { createSessionSearchClient, unavailableSessionSearchStatus } from './ai-vault-search-client'
import { AiVaultSearchRequestSchema as LegacyRequestSchema } from './__fixtures__/pre-qoder-search-request'
import { searchHit, searchResults } from './ai-vault-search-test-fixture'
import { AI_VAULT_AGENTS } from './ai-vault-types'

describe.each(['qoder', 'jcode'] as const)('%s search negotiation', (agent) => {
  const supportField = agent === 'qoder' ? 'supportsQoderHistory' : 'supportsJcodeHistory'
  it('keeps the frozen old parser closed to the requested agent', () => {
    expect(
      LegacyRequestSchema.safeParse({ query: 'q', filters: { agents: [agent] } }).success
    ).toBe(false)
  })

  it.each(['runtime', 'relay'] as const)(
    'sends no search request for an unsupported agent over %s',
    async (transport) => {
      const search = vi.fn((params: unknown) => {
        LegacyRequestSchema.parse(params)
        return searchResults()
      })
      const status = vi.fn(() => unavailableSessionSearchStatus())
      const client = createSessionSearchClient(
        async (method, params) => (method === 'aiVault.searchStatus' ? status() : search(params)),
        transport
      )
      expect(await client.searchSessions({ query: 'q', filters: { agents: [agent] } })).toEqual({
        kind: 'unavailable',
        reason: 'unsupported-agent'
      })
      expect(status).toHaveBeenCalledTimes(1)
      expect(search).not.toHaveBeenCalled()
    }
  )

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
          since: '2026-08-01T00:00:00Z',
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

  it.each(['runtime', 'relay'] as const)(
    'preserves the requested agent identity only after positive host attestation over %s',
    async (transport) => {
      const call = vi.fn(async (method: string) =>
        method === 'aiVault.searchStatus'
          ? { ...unavailableSessionSearchStatus(), [supportField]: true }
          : { ...searchResults(), hits: [{ ...searchHit(), agent }] }
      )
      const result = await createSessionSearchClient(call, transport).searchSessions({
        query: 'q',
        filters: { agents: [agent] }
      })
      expect(call.mock.calls.map(([method]) => method)).toEqual([
        'aiVault.searchStatus',
        'aiVault.searchSessions'
      ])
      expect(call).toHaveBeenLastCalledWith('aiVault.searchSessions', {
        query: 'q',
        limit: 20,
        filters: { agents: [agent] },
        includeDshHistory: true,
        includeReasonixHistory: true,
        supportedAgents: [...AI_VAULT_AGENTS],
        supportsQoderHistory: true,
        supportsJcodeHistory: true
      })
      expect(result).toMatchObject({ kind: 'results', hits: [{ agent }] })
    }
  )

  it('does not infer support from the other agent capability', async () => {
    const otherField = agent === 'qoder' ? 'supportsJcodeHistory' : 'supportsQoderHistory'
    const call = vi.fn(async (method: string) =>
      method === 'aiVault.searchStatus'
        ? { ...unavailableSessionSearchStatus(), [otherField]: true }
        : searchResults()
    )
    await createSessionSearchClient(call, 'relay').searchSessions({
      query: 'q',
      filters: { agents: [agent, 'codex'] }
    })
    expect(call).toHaveBeenLastCalledWith('aiVault.searchSessions', {
      query: 'q',
      limit: 20,
      filters: { agents: ['codex'] },
      includeDshHistory: true,
      includeReasonixHistory: true,
      supportedAgents: [...AI_VAULT_AGENTS],
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    })
  })

  it('does not gate local IPC before the per-host aggregator negotiates', async () => {
    const call = vi.fn(async () => searchResults())
    await createSessionSearchClient(call, 'ipc').searchSessions({
      query: 'q',
      filters: { agents: [agent] }
    })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchSessions', {
      query: 'q',
      limit: 20,
      filters: { agents: [agent] },
      includeDshHistory: true,
      includeReasonixHistory: true,
      supportedAgents: [...AI_VAULT_AGENTS],
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    })
  })

  it('does not dispatch a search when the capability probe loses host contact', async () => {
    const call = vi.fn(async () => {
      throw new Error('host disconnected')
    })
    await expect(
      createSessionSearchClient(call, 'relay').searchSessions({
        query: 'q',
        filters: { agents: [agent, 'codex'] }
      })
    ).rejects.toThrow('host disconnected')
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })

  it.each(['runtime', 'relay'] as const)(
    'does not send sole Jcode to a host that only attests Qoder over %s',
    async (transport) => {
      const call = vi.fn(async () => ({
        ...unavailableSessionSearchStatus(),
        supportsQoderHistory: true
      }))
      expect(
        await createSessionSearchClient(call, transport).searchSessions({
          query: 'q',
          filters: { agents: ['jcode'] }
        })
      ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
      expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
    }
  )

  it.each(['runtime', 'relay'] as const)(
    'retains current Jcode support even with no indexed sessions over %s',
    async (transport) => {
      const call = vi.fn(async (method: string) =>
        method === 'aiVault.searchStatus'
          ? {
              ...unavailableSessionSearchStatus(),
              supportedAgents: [...AI_VAULT_AGENTS, 'future-agent'],
              sessionsByAgent: {}
            }
          : { ...searchResults(), hits: [{ ...searchHit(), agent: 'jcode' }] }
      )
      expect(
        await createSessionSearchClient(call, transport).searchSessions({
          query: 'q',
          filters: { agents: ['jcode'] }
        })
      ).toMatchObject({ hits: [{ agent: 'jcode' }] })
      expect(call).toHaveBeenLastCalledWith('aiVault.searchSessions', {
        query: 'q',
        limit: 20,
        filters: { agents: ['jcode'] },
        includeDshHistory: true,
        includeReasonixHistory: true,
        supportedAgents: [...AI_VAULT_AGENTS],
        supportsQoderHistory: true,
        supportsJcodeHistory: true
      })
    }
  )

  it('uses an explicit host catalog before either historical capability', async () => {
    const call = vi.fn(async () => ({
      ...unavailableSessionSearchStatus(),
      supportedAgents: [],
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    }))
    expect(
      await createSessionSearchClient(call, 'relay').searchSessions({
        query: 'q',
        filters: { agents: ['qoder', 'jcode'] }
      })
    ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })
})

describe('independent negotiated history opt-ins', () => {
  it.each([
    { dshHistory: false, reasonixHistory: false, supportsQoderHistory: false, agents: ['codex'] },
    {
      dshHistory: true,
      reasonixHistory: false,
      supportsQoderHistory: false,
      agents: ['dsh', 'codex']
    },
    {
      dshHistory: false,
      reasonixHistory: true,
      supportsQoderHistory: false,
      agents: ['reasonix', 'codex']
    },
    {
      dshHistory: false,
      reasonixHistory: false,
      supportsQoderHistory: true,
      agents: ['qoder', 'codex']
    },
    {
      dshHistory: true,
      reasonixHistory: true,
      supportsQoderHistory: true,
      agents: ['reasonix', 'dsh', 'qoder', 'codex']
    }
  ])('negotiates independent history capabilities in one probe: $agents', async (capabilities) => {
    for (const transport of ['runtime', 'relay'] as const) {
      const { agents, ...advertised } = capabilities
      const call = vi.fn(async (method: string) =>
        method === 'aiVault.searchStatus'
          ? { ...unavailableSessionSearchStatus(), ...advertised }
          : searchResults()
      )
      await createSessionSearchClient(call, transport).searchSessions({
        query: 'needle',
        limit: 1,
        cursor: 'next-page',
        filters: { agents: ['reasonix', 'dsh', 'qoder', 'codex'], scopePaths: ['/host/folder'] }
      })
      expect(call.mock.calls.map(([method]) => method)).toEqual([
        'aiVault.searchStatus',
        'aiVault.searchSessions'
      ])
      expect(call).toHaveBeenLastCalledWith('aiVault.searchSessions', {
        query: 'needle',
        limit: 1,
        cursor: 'next-page',
        filters: { agents, scopePaths: ['/host/folder'] },
        includeDshHistory: true,
        includeReasonixHistory: true,
        supportedAgents: [...AI_VAULT_AGENTS],
        supportsQoderHistory: true,
        supportsJcodeHistory: true
      })
    }
  })
})
