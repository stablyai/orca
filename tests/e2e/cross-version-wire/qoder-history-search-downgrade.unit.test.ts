import { afterEach, expect, test, vi } from 'vitest'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../src/shared/ai-vault-search-client'
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
import { AI_VAULT_AGENTS } from '../../../src/shared/ai-vault-types'
import { redactForTransport } from '../../../src/shared/ai-vault-search-transport'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

const PRE_QODER_HOSTS = ['v1.4.211', 'b49abdb1f4da6b3d62dfa9ccf3c74dc9e74d291c']
const QODER_HOST = 'f97ca2a49d9c711dab54a656a7f8a47ae6c6749c'
const LEGACY_AGENTS = AI_VAULT_AGENTS.filter(
  (agent) => !['codebuddy', 'zcode', 'qoder', 'jcode', 'kiro'].includes(agent)
)
afterEach(() => setSessionSearchService(null))

async function releaseSearchSchemas(ref: string) {
  const checkout = await materializeReleaseCheckout(ref)
  return importReleaseCheckoutModule(checkout, 'src/shared/ai-vault-search-contract.ts')
}

function releaseParser(schema: unknown) {
  if (
    !schema ||
    typeof schema !== 'object' ||
    !('parse' in schema) ||
    typeof schema.parse !== 'function' ||
    !('safeParse' in schema) ||
    typeof schema.safeParse !== 'function'
  ) {
    throw new Error('Pinned release has no search parser')
  }
  const parse = schema.parse
  const safeParse = schema.safeParse
  return {
    parse: (value: unknown) => parse.call(schema, value),
    safeParse: (value: unknown) => safeParse.call(schema, value)
  }
}

test.each(['qoder', 'jcode'] as const)(
  'a pre-agent release can read current %s search pages without losing other agents',
  async (agent) => {
    const baseline = await releaseSearchSchemas('v1.4.211')
    const responseParser = releaseParser(baseline.AiVaultSearchResponseSchema)
    const newHit = { ...searchHit(), agent }
    expect(responseParser.safeParse({ ...searchResults(), hits: [newHit] })).toHaveProperty(
      'success',
      false
    )
    const service = fakeSearchService()
    service.search.mockImplementation(async (request) => ({
      ...searchResults(),
      hits:
        !request.filters?.agents || request.filters.agents.includes(agent)
          ? [newHit]
          : searchResults().hits
    }))
    setSessionSearchService(service)
    const oldResponse = await searchSessionService({ query: 'proof' }, 'relay')
    expect(responseParser.safeParse(oldResponse)).toHaveProperty('success', true)
    expect(oldResponse).toMatchObject({ hits: [{ agent: 'codex' }] })
    const client = createSessionSearchClient(
      (_method, request) => searchSessionService(request, 'relay'),
      'relay'
    )
    expect(await client.searchSessions({ query: 'proof' })).toMatchObject({ hits: [{ agent }] })
    expect(
      releaseParser(baseline.AiVaultSearchRequestSchema).safeParse({
        query: 'proof',
        supportedAgents: [...AI_VAULT_AGENTS],
        supportsQoderHistory: true,
        supportsJcodeHistory: true
      })
    ).toHaveProperty('success', true)
  }
)

test.each(PRE_QODER_HOSTS)(
  'the actual %s response parser accepts complete current-host legacy pages',
  async (ref) => {
    const baseline = await releaseSearchSchemas(ref)
    const responseParser = releaseParser(baseline.AiVaultSearchResponseSchema)
    const hits = (['codex', 'codebuddy', 'zcode', 'qoder', 'jcode'] as const).map((agent) => ({
      ...searchHit(),
      agent,
      sessionId: agent
    }))
    expect(responseParser.safeParse({ ...searchResults(), hits })).toHaveProperty('success', false)
    const service = fakeSearchService()
    service.search.mockImplementation(async (request) => ({
      ...searchResults(),
      hits: hits.filter(
        (hit) => !request.filters?.agents || request.filters.agents.includes(hit.agent)
      ),
      page: { cursor: 'legacy-next-page', hasMore: true }
    }))
    setSessionSearchService(service)
    const oldResponse = await searchSessionService({ query: 'proof' }, 'relay')
    expect(responseParser.safeParse(oldResponse)).toHaveProperty('success', true)
    expect(oldResponse).toMatchObject({
      hits: [{ agent: 'codex' }],
      page: { cursor: 'legacy-next-page', hasMore: true }
    })
    expect(service.search).toHaveBeenLastCalledWith(
      { query: 'proof', limit: 20, filters: { agents: LEGACY_AGENTS } },
      undefined
    )
    const nextPage = await searchSessionService(
      { query: 'proof', cursor: 'legacy-next-page' },
      'relay'
    )
    expect(responseParser.safeParse(nextPage)).toHaveProperty('success', true)
    expect(service.search).toHaveBeenLastCalledWith(
      { query: 'proof', cursor: 'legacy-next-page', limit: 20, filters: { agents: LEGACY_AGENTS } },
      undefined
    )
    const client = createSessionSearchClient(
      (method, request) =>
        method === 'aiVault.searchStatus'
          ? sessionSearchServiceStatus(request, 'relay')
          : searchSessionService(request, 'relay'),
      'relay'
    )
    expect(await client.searchSessions({ query: 'proof' })).toMatchObject({
      hits: hits.map((hit) => redactForTransport(hit, 'relay'))
    })
  }
)

test.each(PRE_QODER_HOSTS)(
  'a current client narrows its entire catalog before the actual %s request parser',
  async (ref) => {
    const baseline = await releaseSearchSchemas(ref)
    const requestParser = releaseParser(baseline.AiVaultSearchRequestSchema)
    expect(
      requestParser.safeParse({ query: 'proof', filters: { agents: [...AI_VAULT_AGENTS] } })
    ).toHaveProperty('success', false)
    const call = vi.fn(async (method: string, request: Record<string, unknown>) => {
      if (method === 'aiVault.searchStatus') {
        return { ...unavailableSessionSearchStatus(), enabled: true, phase: 'current' }
      }
      requestParser.parse(request)
      return searchResults()
    })
    const client = createSessionSearchClient(call, 'relay')
    const within = { kind: 'workspace' as const, worktreeId: 'folder:/task-owned/folder' }
    expect(
      await client.searchSessions({
        query: 'proof',
        filters: { agents: [...AI_VAULT_AGENTS] },
        within
      })
    ).toMatchObject({ hits: [{ agent: 'codex' }] })
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenLastCalledWith(
      'aiVault.searchSessions',
      expect.objectContaining({ filters: { agents: LEGACY_AGENTS }, within })
    )
    call.mockClear()
    expect(
      await client.searchSessions({
        query: 'proof',
        filters: { agents: ['qoder', 'jcode', 'codebuddy', 'zcode'] },
        within
      })
    ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
    call.mockClear()
    expect(
      await client.searchSessions({ query: 'proof', filters: { agents: ['codex'] }, within })
    ).toMatchObject({ hits: [{ agent: 'codex' }] })
    expect(call).toHaveBeenCalledTimes(2)
  }
)

test.each(['codebuddy', 'zcode'] as const)(
  'an actual b49 explicit %s request proves the old client can read that agent',
  async (agent) => {
    const baseline = await releaseSearchSchemas(PRE_QODER_HOSTS[1])
    const request = releaseParser(baseline.AiVaultSearchRequestSchema).parse({
      query: 'proof',
      filters: { agents: [agent] }
    })
    const service = fakeSearchService()
    service.search.mockResolvedValue({ ...searchResults(), hits: [{ ...searchHit(), agent }] })
    setSessionSearchService(service)
    const response = await searchSessionService(request, 'relay')
    expect(releaseParser(baseline.AiVaultSearchResponseSchema).safeParse(response)).toHaveProperty(
      'success',
      true
    )
    expect(response).toMatchObject({ hits: [{ agent }] })
    expect(service.search).toHaveBeenCalledExactlyOnceWith(
      { query: 'proof', limit: 20, filters: { agents: [agent] } },
      undefined
    )
  }
)

test('the shipped Qoder capability proves its historical trio while withholding later Jcode', async () => {
  const baseline = await releaseSearchSchemas(QODER_HOST)
  const requestParser = releaseParser(baseline.AiVaultSearchRequestSchema)
  const responseParser = releaseParser(baseline.AiVaultSearchResponseSchema)
  const request = requestParser.parse({ query: 'proof', supportsQoderHistory: true })
  const hits = [
    searchHit(),
    ...(['codebuddy', 'zcode', 'qoder', 'jcode'] as const).map((agent) => ({
      ...searchHit(),
      agent
    }))
  ]
  const service = fakeSearchService()
  service.search.mockImplementation(async (projected) => ({
    ...searchResults(),
    hits: hits.filter(
      (hit) => !projected.filters?.agents || projected.filters.agents.includes(hit.agent)
    )
  }))
  setSessionSearchService(service)
  const response = await searchSessionService(request, 'relay')
  expect(responseParser.safeParse(response)).toHaveProperty('success', true)
  expect(response).toMatchObject({
    hits: hits.filter((hit) => hit.agent !== 'jcode').map((hit) => redactForTransport(hit, 'relay'))
  })
  expect(
    responseParser.safeParse({ ...searchResults(), hits: [{ ...searchHit(), agent: 'jcode' }] })
  ).toHaveProperty('success', false)
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'aiVault.searchStatus') {
      return { ...unavailableSessionSearchStatus(), supportsQoderHistory: true }
    }
    requestParser.parse(params)
    return searchResults()
  })
  await createSessionSearchClient(call, 'relay').searchSessions({
    query: 'proof',
    filters: { agents: [...AI_VAULT_AGENTS] }
  })
  expect(call).toHaveBeenLastCalledWith(
    'aiVault.searchSessions',
    expect.objectContaining({
      filters: { agents: AI_VAULT_AGENTS.filter((agent) => !['jcode', 'kiro'].includes(agent)) }
    })
  )
})
