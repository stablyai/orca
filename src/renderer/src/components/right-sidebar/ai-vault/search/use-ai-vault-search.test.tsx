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
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useAiVaultSearch } from './use-ai-vault-search'

const mockSettings: { aiVaultSearch?: { enabled: boolean } } = {}
vi.mock('@/store/index', () => ({
  useAppStore: (
    select: (state: { settings: typeof mockSettings; runtimeEnvironments: never[] }) => unknown
  ) => select({ settings: mockSettings, runtimeEnvironments: [] })
}))

const feeds = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
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
  feeds.subscribe.mockImplementation(async () => ({ unsubscribe: vi.fn() }))
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

it('keeps the last hits on screen until a newer query answers, ignoring the older reply', async () => {
  const hit = (sessionId: string) => ({ ...searchHit(), sessionId })
  let answerOld = (_response: AiVaultSearchResponse): void => {}
  searchSessions
    .mockResolvedValueOnce({ ...searchResults(), hits: [hit('first')] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerOld = resolve
        })
    )
    .mockResolvedValueOnce({ ...searchResults(), hits: [hit('newest')] })
  const { result, rerender, unmount } = renderHook(
    ({ request }) => useAiVaultSearch(request, 'local', ''),
    { initialProps: { request: { query: 'n' } } }
  )
  await debounce()
  rerender({ request: { query: 'ne' } })
  await debounce()
  rerender({ request: { query: 'nee' } })
  expect(result.current.hits.map((entry) => entry.sessionId)).toEqual(['first'])
  expect(result.current.answered).toBe(false)
  await debounce()
  await act(async () => answerOld({ ...searchResults(), hits: [hit('older')] }))
  expect(result.current.hits.map((entry) => entry.sessionId)).toEqual(['newest'])
  expect(result.current.answered).toBe(true)
  unmount()
})
