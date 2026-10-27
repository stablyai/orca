import { createSessionSearchClient } from '../../../../shared/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../../../shared/ai-vault-search-contract'
import type * as StoreModule from '@/store'
// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultSearchSort } from '../../../../shared/ai-vault-types'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../../shared/ai-vault-search-types'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import { searchHit, searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import { useAiVaultPanelSearch, useAiVaultSearch } from './use-ai-vault-search'

const mockSettings: { aiVaultSearch?: { enabled: boolean } } = {}
vi.mock('@/store', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>()
  return {
    useAppStore: Object.assign(
      (
        select: (state: { settings: typeof mockSettings; runtimeEnvironments: never[] }) => unknown
      ) => select({ settings: mockSettings, runtimeEnvironments: [] }),
      { getState: actual.useAppStore.getState, setState: actual.useAppStore.setState }
    )
  }
})

const feeds = vi.hoisted(() => ({
  subscribe: vi.fn(),
  emit: new Map<string, (event: AgentSessionStatusEvent) => void>()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: feeds.subscribe
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))

const ALL_AGENTS = ['codex' as const]
const ALL_REQUEST = { query: 'needle', filters: { agents: ['codex'] } }
const searchSessions =
  vi.fn<
    (request: AiVaultSearchRequest, scope?: ExecutionHostScope) => Promise<AiVaultSearchResponse>
  >()
const empty: AiVaultSearchResponse = {
  kind: 'results',
  hits: [],
  page: { cursor: null, hasMore: false },
  generation: 1,
  durationMs: 1,
  truncated: { candidates: false, snippets: 0, query: false, freshness: false }
}
beforeEach(() => {
  resetStructuredAgentSessionStatusFeedsForTests()
  feeds.emit.clear()
  feeds.subscribe.mockImplementation(async (target, emit) => {
    feeds.emit.set(target.environmentId ?? 'local', emit)
    return { unsubscribe: vi.fn() }
  })
  vi.useFakeTimers()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions } }
  })
  searchSessions.mockReset().mockResolvedValue(empty)
  delete mockSettings.aiVaultSearch
})
afterEach(() => {
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.useRealTimers()
})
async function debounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}

it('debounces, skips empty/disabled requests, and never substitutes local for an unknown host', async () => {
  const initialProps: { request: AiVaultSearchRequest | null; host: ExecutionHostId | null } = {
    request: null,
    host: null
  }
  const { rerender, unmount } = renderHook(
    ({ request, host }: { request: AiVaultSearchRequest | null; host: ExecutionHostId | null }) =>
      useAiVaultSearch(request, host, ''),
    { initialProps }
  )
  await debounce()
  expect(searchSessions).not.toHaveBeenCalled()
  rerender({ request: { query: 'old' }, host: 'ssh:remote' })
  rerender({ request: { query: 'latest' }, host: 'ssh:remote' })
  await debounce()
  expect(searchSessions).toHaveBeenCalledExactlyOnceWith(
    { query: 'latest', cursor: undefined },
    'ssh:remote',
    expect.any(Function)
  )
  unmount()
})

it('hides old-host results immediately and ignores late success and failure after switching', async () => {
  let resolveOld: (value: AiVaultSearchResponse) => void = () => {}
  searchSessions.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  const request = { query: 'needle' }
  const { result, rerender, unmount } = renderHook(
    ({ host }: { host: ExecutionHostId }) => useAiVaultSearch(request, host, ''),
    { initialProps: { host: 'local' } }
  )
  await debounce()
  rerender({ host: 'ssh:remote' })
  expect(result.current.response).toBeNull()
  await debounce()
  await act(async () => resolveOld({ kind: 'unavailable', reason: 'disabled' }))
  expect(result.current.response).toEqual(empty)
  expect(searchSessions.mock.calls.map((call) => call[1])).toEqual(['local', 'ssh:remote'])
  unmount()
})

it('refuses late responses after unmount and cancels a pending debounce', async () => {
  const request = { query: 'needle' }
  const { unmount } = renderHook(() => useAiVaultSearch(request, 'local', ''))
  unmount()
  await debounce()
  expect(searchSessions).not.toHaveBeenCalled()
})

it('restarts page one after stale cursors without looping on a changing index', async () => {
  searchSessions.mockResolvedValueOnce({ ...empty, page: { cursor: 'page-2', hasMore: true } })
  const request = { query: 'needle', filters: { agents: ['claude' as const] } }
  const { result, unmount } = renderHook(() => useAiVaultSearch(request, 'runtime:owner', ''))
  await debounce()
  searchSessions
    .mockResolvedValueOnce({ kind: 'stale-cursor', generation: 2 })
    .mockResolvedValueOnce({ kind: 'stale-cursor', generation: 3 })
  act(() => result.current.loadMore())
  await debounce()
  expect(searchSessions.mock.calls[1]).toEqual([
    { ...request, cursor: 'page-2' },
    'runtime:owner',
    expect.any(Function)
  ])
  expect(searchSessions.mock.calls[2]).toEqual([request, 'runtime:owner', expect.any(Function)])
  expect(searchSessions).toHaveBeenCalledTimes(3)
  expect(result.current.response?.kind).toBe('stale-cursor')
  unmount()
})

it('keeps transport errors and unavailable reasons distinct and retries after consent changes', async () => {
  searchSessions.mockRejectedValueOnce(new Error('offline'))
  const request = { query: 'needle' }
  const { result, rerender, unmount } = renderHook(
    ({ policy }) => useAiVaultSearch(request, 'local', policy),
    { initialProps: { policy: 'disabled' } }
  )
  await debounce()
  expect(result.current.error).toBe(true)
  searchSessions.mockResolvedValueOnce({ kind: 'unavailable', reason: 'no-service' })
  act(() => result.current.retry())
  await debounce()
  expect(result.current.error).toBe(false)
  expect(result.current.response).toEqual({ kind: 'unavailable', reason: 'no-service' })
  rerender({ policy: 'enabled' })
  expect(result.current.response).toBeNull()
  await debounce()
  expect(result.current.response?.kind).toBe('results')
  unmount()
})

it('discards pagination when a host is left and revisited, and replaces stale pages', async () => {
  const first = searchResults()
  searchSessions.mockResolvedValueOnce({ ...first, page: { cursor: 'next', hasMore: true } })
  const request = { query: 'needle' }
  const { result, rerender, unmount } = renderHook(
    ({ host }: { host: ExecutionHostId }) => useAiVaultSearch(request, host, ''),
    { initialProps: { host: 'local' } }
  )
  await debounce()
  searchSessions
    .mockResolvedValueOnce({ kind: 'stale-cursor', generation: 8 })
    .mockResolvedValueOnce({ ...first, hits: [{ ...first.hits[0], sessionId: 'replacement' }] })
  act(() => {
    result.current.loadMore()
    result.current.loadMore()
  })
  await debounce()
  expect(result.current.hits.map((hit) => hit.sessionId)).toEqual(['replacement'])
  expect(searchSessions).toHaveBeenCalledTimes(3)
  rerender({ host: 'ssh:other' })
  await debounce()
  rerender({ host: 'local' })
  await debounce()
  expect(searchSessions.mock.calls.at(-1)).toEqual([
    { ...request, cursor: undefined },
    'local',
    expect.any(Function)
  ])
  unmount()
})

it('ignores a late failure for a superseded query', async () => {
  let rejectOld: (error: Error) => void = () => {}
  searchSessions.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject
      })
  )
  const { result, rerender, unmount } = renderHook(
    ({ request }) => useAiVaultSearch(request, 'local', ''),
    { initialProps: { request: { query: 'old' } } }
  )
  await debounce()
  rerender({ request: { query: 'new' } })
  await debounce()
  await act(async () => rejectOld(new Error('offline')))
  expect(result.current.error).toBe(false)
  expect(result.current.response).toEqual(empty)
  unmount()
})

it('does not revive old results or cursors before debounce when returning from an invalid host', async () => {
  const request = { query: 'needle' }
  searchSessions.mockResolvedValueOnce({
    ...searchResults(),
    page: { cursor: 'obsolete', hasMore: true }
  })
  const initialProps: { host: ExecutionHostId | null } = { host: 'local' }
  const { result, rerender, unmount } = renderHook(
    ({ host }) => useAiVaultSearch(host ? request : null, host, ''),
    { initialProps }
  )
  await debounce()
  expect(result.current.hits.length).toBe(1)
  rerender({ host: null })
  rerender({ host: 'local' })
  expect(result.current.hits).toEqual([])
  expect(result.current.response).toBeNull()
  expect(result.current.loading).toBe(true)
  act(() => result.current.loadMore())
  expect(searchSessions).toHaveBeenCalledTimes(1)
  await debounce()
  expect(searchSessions.mock.calls.at(-1)).toEqual([
    { ...request, cursor: undefined },
    'local',
    expect.any(Function)
  ])
  unmount()
})

it('removes a confirmed-deleted hit without re-querying a potentially stale index', async () => {
  const response = searchResults()
  searchSessions.mockResolvedValue(response)
  const request = { query: 'needle' }
  const { result, unmount } = renderHook(() => useAiVaultSearch(request, 'local', ''))
  await debounce()
  act(() => result.current.removeHit(response.hits[0]))
  expect(result.current.hits).toEqual([])
  expect(searchSessions).toHaveBeenCalledTimes(1)
  unmount()
})

it('searches every computer at once and keeps each hit on the computer that owns it', async () => {
  searchSessions.mockResolvedValueOnce({
    ...searchResults(),
    hits: [
      { ...searchHit(), sessionId: 'remote', executionHostId: 'ssh:build-box' },
      { ...searchHit(), sessionId: 'unattributed' }
    ],
    generation: 0,
    hosts: [
      { executionHostId: 'local', outcome: 'searched' },
      { executionHostId: 'ssh:build-box', outcome: 'searched' }
    ]
  })
  const { result, unmount } = renderHook(() =>
    useAiVaultPanelSearch('needle', ALL_AGENTS, undefined, 'all', 'relevance')
  )
  await debounce()
  expect(searchSessions).toHaveBeenCalledExactlyOnceWith(
    { ...ALL_REQUEST, cursor: undefined },
    'all',
    expect.any(Function)
  )
  expect(result.current.sessions.map((session) => session.executionHostId)).toEqual([
    'ssh:build-box',
    'local'
  ])
  unmount()
})

it('sends the sort only when it is not the host default', async () => {
  const initialProps: { sort: AiVaultSearchSort } = { sort: 'relevance' }
  const { rerender, unmount } = renderHook(
    ({ sort }) => useAiVaultPanelSearch('needle', ALL_AGENTS, undefined, 'all', sort),
    { initialProps }
  )
  await debounce()
  expect(searchSessions.mock.calls[0]?.[0]).toEqual({
    query: 'needle',
    filters: { agents: ALL_AGENTS },
    cursor: undefined
  })
  rerender({ sort: 'newest' })
  await debounce()
  expect(searchSessions.mock.calls[1]?.[0]).toEqual({
    query: 'needle',
    filters: { agents: ALL_AGENTS, sort: 'newest' },
    cursor: undefined
  })
  unmount()
})

it('restarts page one under the all scope when the merged cursor goes stale', async () => {
  searchSessions.mockResolvedValueOnce({
    ...searchResults(),
    generation: 0,
    page: { cursor: 'merged', hasMore: true }
  })
  const { result, unmount } = renderHook(() =>
    useAiVaultPanelSearch('needle', ALL_AGENTS, undefined, 'all', 'relevance')
  )
  await debounce()
  searchSessions
    .mockResolvedValueOnce({ kind: 'stale-cursor', generation: 0 })
    .mockResolvedValueOnce({ ...searchResults(), generation: 0 })
  act(() => result.current.loadMore())
  await debounce()
  expect(searchSessions.mock.calls[1]).toEqual([
    { ...ALL_REQUEST, cursor: 'merged' },
    'all',
    expect.any(Function)
  ])
  expect(searchSessions.mock.calls[2]).toEqual([ALL_REQUEST, 'all', expect.any(Function)])
  expect(result.current.sessions.map((session) => session.executionHostId)).toEqual(['local'])
  unmount()
})

it('leaves the box as the legacy title filter while local indexing consent is pending', async () => {
  const { result, unmount } = renderHook(() =>
    useAiVaultPanelSearch('needle', ALL_AGENTS, undefined, 'local', 'relevance')
  )
  await debounce()
  expect(searchSessions).not.toHaveBeenCalled()
  expect(result.current.searching).toBe(false)
  expect(result.current.hasQuery).toBe(true)
  expect(result.current.needsLocalConsent).toBe(true)
  expect(result.current.loading).toBe(false)
  expect(result.current.sessions).toEqual([])
  unmount()
})

it('searches the local index with the same query once consent is on', async () => {
  mockSettings.aiVaultSearch = { enabled: true }
  const { result, unmount } = renderHook(() =>
    useAiVaultPanelSearch('needle', ALL_AGENTS, undefined, 'local', 'relevance')
  )
  await debounce()
  expect(searchSessions).toHaveBeenCalledExactlyOnceWith(
    { ...ALL_REQUEST, cursor: undefined },
    'local',
    expect.any(Function)
  )
  expect(result.current.searching).toBe(true)
  expect(result.current.hasQuery).toBe(true)
  expect(result.current.needsLocalConsent).toBe(false)
  unmount()
})

it('is neither searching nor holding a query for a blank box', async () => {
  const { result, unmount } = renderHook(() =>
    useAiVaultPanelSearch('   ', ALL_AGENTS, undefined, 'local', 'relevance')
  )
  await debounce()
  expect(searchSessions).not.toHaveBeenCalled()
  expect(result.current.searching).toBe(false)
  expect(result.current.hasQuery).toBe(false)
  unmount()
})

// #22453: a host's index is not this client's to turn on, so its "off" must not wall the list.
it.each(['disabled', 'no-service'] as const)(
  'falls back to the title filter when a single host answers %s',
  async (reason) => {
    searchSessions.mockResolvedValue({ kind: 'unavailable', reason })
    const initialProps = { query: 'needle' }
    const { result, rerender, unmount } = renderHook(
      ({ query }) => useAiVaultPanelSearch(query, ALL_AGENTS, undefined, 'ssh:box', 'relevance'),
      { initialProps }
    )
    await debounce()
    expect(result.current.searching).toBe(false)
    expect(result.current.titleOnly).toBe(true)
    expect(result.current.loading).toBe(false)

    rerender({ query: 'needles' })
    await debounce()
    expect(searchSessions).toHaveBeenCalledOnce()
    expect(result.current.searching).toBe(false)
    unmount()
  }
)

it('keeps full-text search for a host that is merely not ready', async () => {
  searchSessions.mockResolvedValue({ kind: 'unavailable', reason: 'not-ready' })
  const { result, unmount } = renderHook(() =>
    useAiVaultPanelSearch('needle', ALL_AGENTS, undefined, 'ssh:box', 'relevance')
  )
  await debounce()
  expect(result.current.searching).toBe(true)
  expect(result.current.titleOnly).toBe(false)
  unmount()
})

// The real client parses before transport; top-level intent would disappear here.
it('carries both Project identities through the actual panel parser and continuation', async () => {
  const requests: AiVaultSearchRequest[] = []
  const client = createSessionSearchClient(async (_method, params) => {
    requests.push(AiVaultSearchRequestSchema.parse(params))
    return {
      ...empty,
      page: { cursor: requests.length === 1 ? 'next' : null, hasMore: requests.length === 1 }
    }
  }, 'ipc')
  searchSessions.mockImplementation((request) => client.searchSessions(request))
  const within = { kind: 'project', projectKey: 'project:shared' } as const
  const { result, unmount } = renderHook(() =>
    useAiVaultPanelSearch('needle', ALL_AGENTS, within, 'all', 'relevance', 'repo:b')
  )
  await debounce()
  act(() => result.current.loadMore())
  await debounce()
  expect(requests.map((request) => request.within)).toEqual([
    { ...within, canonicalProjectKey: 'repo:b' },
    { ...within, canonicalProjectKey: 'repo:b' }
  ])
  expect(requests.map((request) => request.cursor)).toEqual([undefined, 'next'])
  expect(within).toEqual({ kind: 'project', projectKey: 'project:shared' })
  unmount()
})

it('revalidates active search without losing hits, accepting old pages, or touching another host', async () => {
  const request = { query: 'inventory' }
  const owned = {
    ...searchHit(),
    title: 'Budget plan',
    structuredSession: { sessionId: 'native', workspaceId: 'workspace' }
  }
  searchSessions.mockResolvedValue({
    ...searchResults(),
    hits: [owned],
    page: { cursor: 'old-page', hasMore: true }
  })
  const a = renderHook(() => useAiVaultSearch(request, 'runtime:a', ''))
  const b = renderHook(() => useAiVaultSearch(request, 'runtime:b', ''))
  const summary = {
    sessionId: 'native',
    workspaceId: 'workspace',
    agent: 'pi' as const,
    latestPrompt: '',
    status: null,
    updatedAt: 1,
    providerSession: { key: 'session_id' as const, id: '/provider' }
  }
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  await act(async () => feeds.emit.get('a')?.({ type: 'snapshot', sessions: [summary] }))
  await debounce()
  const baseline = searchSessions.mock.calls.length
  for (const n of [10, 100]) {
    await act(async () => {
      for (let i = 0; i < n; i++) {
        feeds.emit.get('a')?.({
          type: 'status',
          session: { ...summary, updatedAt: i, toolName: `${i}` }
        })
        feeds.emit.get('a')?.({
          type: 'snapshot',
          sessions: [],
          namingActiveSessionIds: [],
          conversationNames: [{ sessionId: 'native', conversationName: `${i}` }]
        })
      }
    })
    expect(searchSessions).toHaveBeenCalledTimes(baseline)
  }
  let settlePage = (_response: AiVaultSearchResponse): void => {}
  searchSessions.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settlePage = resolve
      })
  )
  act(() => a.result.current.loadMore())
  const { providerSession: _provider, ...detached } = summary
  await act(async () => {
    for (const id of ['/next', '/third']) {
      feeds.emit.get('a')?.({
        type: 'status',
        session: {
          ...summary,
          providerSession: { key: 'session_id', id }
        }
      })
    }
    feeds.emit.get('a')?.({ type: 'status', session: detached })
  })
  expect(a.result.current.hits).toEqual([owned])
  const recovered = { ...searchHit(), title: 'Check inventory' }
  searchSessions.mockResolvedValueOnce({ ...searchResults(), hits: [recovered] })
  await act(async () =>
    settlePage({ ...searchResults(), hits: [{ ...searchHit(), title: 'obsolete' }] })
  )
  expect(a.result.current.hits).toEqual([recovered])
  expect(b.result.current.hits).toEqual([owned])
  expect(
    searchSessions.mock.calls.slice(baseline).map(([args, scope]) => [args.cursor, scope])
  ).toEqual([
    ['old-page', 'runtime:a'],
    [undefined, 'runtime:a']
  ])
  a.unmount()
  b.unmount()
  await act(async () => feeds.emit.get('a')?.({ type: 'snapshot', sessions: [] }))
  expect(searchSessions).toHaveBeenCalledTimes(baseline + 2)
})
