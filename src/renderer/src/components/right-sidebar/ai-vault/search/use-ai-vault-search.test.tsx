// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../../../../shared/ai-vault/search/ai-vault-search-types'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../../../shared/execution-host'
import {
  searchHit,
  searchResults
} from '../../../../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { useAiVaultSearch } from './use-ai-vault-search'

const mockSettings: { aiVaultSearch?: { enabled: boolean } } = {}
vi.mock('@/store/index', () => ({
  useAppStore: (
    select: (state: { settings: typeof mockSettings; runtimeEnvironments: never[] }) => unknown
  ) => select({ settings: mockSettings, runtimeEnvironments: [] })
}))

const feeds = vi.hoisted(() => ({
  subscribe: vi.fn(),
  emit: new Map<string, (event: AgentSessionStatusEvent) => void>()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: feeds.subscribe
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))

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
  expect(searchSessions.mock.calls.at(-1)).toEqual([{ ...request, cursor: undefined }, 'local'])
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
  expect(searchSessions.mock.calls.at(-1)).toEqual([{ ...request, cursor: undefined }, 'local'])
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
