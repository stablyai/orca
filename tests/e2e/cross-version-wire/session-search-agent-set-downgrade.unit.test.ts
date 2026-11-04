import { createSessionSearchService } from '../../../src/main/ai-vault-search/session-search-service'
import {
  addSyntheticSession,
  openSessionSearchHarness
} from '../../../src/main/ai-vault-search/session-search-engine-test-fixture'
import { afterEach, expect, test, vi } from 'vitest'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../src/shared/ai-vault-search-client'
import { AI_VAULT_AGENTS } from '../../../src/shared/ai-vault-types'
import {
  searchHit,
  searchResults,
  fakeSearchService
} from '../../../src/shared/ai-vault-search-test-fixture'
import {
  searchSessionService,
  sessionSearchServiceStatus,
  setSessionSearchService
} from '../../../src/main/ai-vault-search/session-search-service-registry'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import { prepareReleaseFixtures } from './release-fixture-setup'

const LEGACY_REF = 'b49abdb1f4da6b3d62dfa9ccf3c74dc9e74d291c'
const releaseSearchSchemas = prepareReleaseFixtures(['v1.4.211', LEGACY_REF], async (ref) =>
  importReleaseCheckoutModule(
    await materializeReleaseCheckout(ref),
    'src/shared/ai-vault-search-contract.ts'
  )
)
afterEach(() => setSessionSearchService(null))

test('the actual pre-Jcode client reads current host pages while current peers retain every provider', async () => {
  const baseline = releaseSearchSchemas(LEGACY_REF)
  const oldResponse = baseline.AiVaultSearchResponseSchema
  if (
    !oldResponse ||
    typeof oldResponse !== 'object' ||
    !('safeParse' in oldResponse) ||
    typeof oldResponse.safeParse !== 'function'
  ) {
    throw new Error('Pinned release has no response parser')
  }
  const hits = (['codex', 'qoder', 'jcode'] as const).map((agent) => ({ ...searchHit(), agent }))
  expect(oldResponse.safeParse({ ...searchResults(), hits: [hits[2]] })).toHaveProperty(
    'success',
    false
  )
  const service = fakeSearchService()
  service.search.mockImplementation(async (request) => ({
    ...searchResults(),
    hits: hits.filter(
      (hit) => !request.filters?.agents?.length || request.filters.agents.includes(hit.agent)
    )
  }))
  setSessionSearchService(service)
  const legacy = await searchSessionService({ query: 'proof' }, 'relay')
  expect(oldResponse.safeParse(legacy)).toHaveProperty('success', true)
  expect(legacy).toMatchObject({ hits: [{ agent: 'codex' }] })
  const client = createSessionSearchClient(
    (method, params) =>
      method === 'aiVault.searchStatus'
        ? sessionSearchServiceStatus(params, 'relay')
        : searchSessionService(params, 'relay'),
    'relay'
  )
  expect(await client.searchSessions({ query: 'proof' })).toMatchObject({
    hits: [{ agent: 'codex' }, { agent: 'qoder' }, { agent: 'jcode' }]
  })
  expect(await sessionSearchServiceStatus({}, 'relay')).toMatchObject({
    supportedAgents: [...AI_VAULT_AGENTS]
  })
})

test.each(['runtime', 'relay'] as const)(
  'a new %s client refuses sole unsupported Jcode without widening the query',
  async (transport) => {
    const call = vi.fn(async () => unavailableSessionSearchStatus())
    expect(
      await createSessionSearchClient(call, transport).searchSessions({
        query: 'proof',
        filters: { agents: ['jcode'] }
      })
    ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  }
)

test.each([{ supportedAgents: [] }, { supportedAgents: ['future-agent'] }])(
  'a client with no shared advertised agents returns no indexed rows for %j',
  async ({ supportedAgents }) => {
    const harness = await openSessionSearchHarness('ss-empty-peer-agents')
    try {
      addSyntheticSession(harness.db, { id: 1, agent: 'codex' })
      addSyntheticSession(harness.db, { id: 2, agent: 'jcode' })
      const retrieve = vi.spyOn(harness.engine, 'search')
      const service = createSessionSearchService({
        engine: harness.engine,
        indexer: {
          status: () => ({
            ...unavailableSessionSearchStatus(),
            messagesIndexed: 0,
            degradedRoots: [],
            sessionsByAgent: {}
          }),
          reconcile: async () => {}
        }
      })
      setSessionSearchService(service)
      const reply = await searchSessionService({ query: 'needle', supportedAgents }, 'runtime')
      expect(reply).toMatchObject({ hits: [], page: { cursor: null, hasMore: false } })
      expect(retrieve).toHaveBeenCalledExactlyOnceWith({
        query: 'needle',
        limit: 20,
        filters: { scopePaths: [''] }
      })
      expect(retrieve.mock.results[0]).toMatchObject({
        type: 'return',
        value: { hits: [], page: { cursor: null, hasMore: false } }
      })
    } finally {
      setSessionSearchService(null)
      await harness.close()
    }
  }
)

test.each(['v1.4.211', LEGACY_REF])(
  'a missing status method still searches through the actual %s request parser',
  async (ref) => {
    const baseline = releaseSearchSchemas(ref)
    const parser = baseline.AiVaultSearchRequestSchema
    const parse =
      parser && typeof parser === 'object' && 'parse' in parser ? parser.parse : undefined
    if (typeof parse !== 'function') {
      throw new Error('Pinned release has no request parser')
    }
    const call = vi.fn(async (method: string, request: Record<string, unknown>) => {
      if (method === 'aiVault.searchStatus') {
        throw { code: 'method_not_found' }
      }
      parse.call(parser, request)
      expect(request).toMatchObject({
        filters: {
          agents: AI_VAULT_AGENTS.filter(
            (agent) => !['codebuddy', 'zcode', 'qoder', 'jcode', 'kiro'].includes(agent)
          ),
          scopePaths: ['/execution-host/folder']
        }
      })
      return searchResults()
    })
    expect(
      await createSessionSearchClient(call, 'relay').searchSessions({
        query: 'needle',
        filters: { agents: [...AI_VAULT_AGENTS], scopePaths: ['/execution-host/folder'] }
      })
    ).toMatchObject({ kind: 'results' })
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'aiVault.searchStatus',
      'aiVault.searchSessions'
    ])
  }
)
