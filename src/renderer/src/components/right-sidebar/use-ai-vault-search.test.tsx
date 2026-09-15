// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../../shared/ai-vault-search-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import { useAiVaultSearch } from './use-ai-vault-search'

const searchSessions =
  vi.fn<(request: AiVaultSearchRequest, host?: ExecutionHostId) => Promise<AiVaultSearchResponse>>()
const empty: AiVaultSearchResponse = {
  kind: 'results',
  hits: [],
  page: { cursor: null, hasMore: false },
  generation: 1,
  durationMs: 1,
  truncated: { candidates: false, snippets: 0, query: false, freshness: false }
}
beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions } }
  })
  searchSessions.mockReset().mockResolvedValue(empty)
})
afterEach(() => vi.useRealTimers())
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
    'ssh:remote'
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
  expect(searchSessions.mock.calls[1]).toEqual([{ ...request, cursor: 'page-2' }, 'runtime:owner'])
  expect(searchSessions.mock.calls[2]).toEqual([request, 'runtime:owner'])
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
