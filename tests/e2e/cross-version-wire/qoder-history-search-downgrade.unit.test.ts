import { afterEach, expect, test, vi } from 'vitest'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../src/shared/ai-vault-search-client'
import { searchResults, fakeSearchService } from '../../../src/shared/ai-vault-search-test-fixture'
import {
  searchSessionService,
  setSessionSearchService
} from '../../../src/main/ai-vault-search/session-search-service-registry'
import { AI_VAULT_AGENTS } from '../../../src/shared/ai-vault-types'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

afterEach(() => setSessionSearchService(null))

test('a pre-Qoder release can read current host search pages without losing other agents', async () => {
  const checkout = await materializeReleaseCheckout('v1.4.211')
  const baseline = await importReleaseCheckoutModule(
    checkout,
    'src/shared/ai-vault-search-contract.ts'
  )
  const schema = baseline.AiVaultSearchResponseSchema
  if (
    !schema ||
    typeof schema !== 'object' ||
    !('safeParse' in schema) ||
    typeof schema.safeParse !== 'function'
  ) {
    throw new Error('The pinned release has no search response parser')
  }
  const qoder = { ...searchResults().hits[0], agent: 'qoder' as const }
  expect(schema.safeParse({ ...searchResults(), hits: [qoder] })).toHaveProperty('success', false)
  const service = fakeSearchService()
  service.search.mockImplementation(async (request) => ({
    ...searchResults(),
    hits:
      !request.filters?.agents || request.filters.agents.includes('qoder')
        ? [qoder]
        : searchResults().hits
  }))
  setSessionSearchService(service)
  const oldResponse = await searchSessionService({ query: 'proof' }, 'relay')
  expect(schema.safeParse(oldResponse)).toHaveProperty('success', true)
  expect(oldResponse).toMatchObject({ hits: [{ agent: 'codex' }] })
  const client = createSessionSearchClient(
    (_method, request) => searchSessionService(request, 'relay'),
    'relay'
  )
  expect(await client.searchSessions({ query: 'proof' })).toMatchObject({
    hits: [{ agent: 'qoder' }]
  })
  const oldRequest = baseline.AiVaultSearchRequestSchema
  if (
    !oldRequest ||
    typeof oldRequest !== 'object' ||
    !('safeParse' in oldRequest) ||
    typeof oldRequest.safeParse !== 'function'
  ) {
    throw new Error('The pinned release has no search request parser')
  }
  expect(
    oldRequest.safeParse({ query: 'proof', supportsQoderHistory: true, supportsKiroHistory: true })
  ).toHaveProperty('success', true)
})

test.each(['v1.4.211', 'b49abdb1f4da6b3d62dfa9ccf3c74dc9e74d291c'])(
  'a current client narrows Qoder filters before calling the actual %s request parser',
  async (ref) => {
    const checkout = await materializeReleaseCheckout(ref)
    const baseline = await importReleaseCheckoutModule(
      checkout,
      'src/shared/ai-vault-search-contract.ts'
    )
    const requestSchema = baseline.AiVaultSearchRequestSchema
    if (
      !requestSchema ||
      typeof requestSchema !== 'object' ||
      !('parse' in requestSchema) ||
      typeof requestSchema.parse !== 'function'
    ) {
      throw new Error('Pinned host has no search request parser')
    }
    const call = vi.fn(async (method: string, request: Record<string, unknown>) => {
      if (method === 'aiVault.searchStatus') {
        return { ...unavailableSessionSearchStatus(), enabled: true, phase: 'current' }
      }
      requestSchema.parse(request)
      return searchResults()
    })
    const within = { kind: 'workspace' as const, worktreeId: 'folder:/task-owned/folder' }
    const client = createSessionSearchClient(call, 'relay')
    expect(
      await client.searchSessions({
        query: 'proof',
        filters: { agents: ['codex', 'qoder'] },
        within
      })
    ).toMatchObject({ hits: [{ agent: 'codex' }] })
    expect(call).toHaveBeenLastCalledWith(
      'aiVault.searchSessions',
      expect.objectContaining({
        filters: { agents: ['codex'] },
        within
      })
    )
    // A host that predates Kiro rejects its tag the same way, so it is narrowed alike.
    expect(
      await client.searchSessions({
        query: 'proof',
        filters: { agents: ['codex', 'kiro'] },
        within
      })
    ).toMatchObject({ hits: [{ agent: 'codex' }] })
    expect(call).toHaveBeenLastCalledWith(
      'aiVault.searchSessions',
      expect.objectContaining({ filters: { agents: ['codex'] }, within })
    )
    call.mockClear()
    expect(
      await client.searchSessions({ query: 'proof', filters: { agents: ['qoder'] }, within })
    ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('aiVault.searchStatus', {})
    if (ref.startsWith('b49')) {
      expect(
        await client.searchSessions({ query: 'proof', filters: { agents: [...AI_VAULT_AGENTS] } })
      ).toMatchObject({ hits: [{ agent: 'codex' }] })
      expect(call).toHaveBeenLastCalledWith(
        'aiVault.searchSessions',
        expect.objectContaining({
          filters: {
            agents: AI_VAULT_AGENTS.filter((agent) => agent !== 'qoder' && agent !== 'kiro')
          }
        })
      )
    }
  }
)
