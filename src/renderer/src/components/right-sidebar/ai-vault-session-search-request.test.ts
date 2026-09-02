// @vitest-environment happy-dom

import { createElement, StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultSearchArgs,
  AiVaultSearchResult
} from '../../../../shared/ai-vault-search-types'
import {
  AI_VAULT_SEARCH_SETTLED_DELAY_MS,
  AI_VAULT_SEARCH_TYPING_DELAY_MS,
  useAiVaultSessionSearchRequest
} from './ai-vault-session-search-request'

function searchResult(query: string): AiVaultSearchResult {
  return {
    hits: [],
    route: 'and',
    durationMs: 1,
    coverage: {
      sessionsIndexed: 0,
      messagesIndexed: 0,
      providers: [],
      backfill: 'idle',
      filesPending: 0,
      lastIndexedAt: null
    },
    repairedTerms: [query]
  }
}

let searchSessions: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  searchSessions = vi.fn(async (args: AiVaultSearchArgs) => searchResult(args.query))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions } }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const argsFor = (query: string): AiVaultSearchArgs => ({ query, limit: 20 })
// The renderer mounts this panel under StrictMode, where every effect is
// mounted, torn down and remounted; a debounce that leaks across that would
// double every request.
const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
  createElement(StrictMode, null, children)

describe('useAiVaultSessionSearchRequest', () => {
  it('issues nothing while the debounce is still running', () => {
    renderHook(() => useAiVaultSessionSearchRequest(argsFor('alpha')), { wrapper })
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_TYPING_DELAY_MS - 1)
    })
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('runs the conversation tier first and the full tier once typing settles', () => {
    renderHook(() => useAiVaultSessionSearchRequest(argsFor('alpha')), { wrapper })
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_TYPING_DELAY_MS)
    })
    expect(searchSessions).toHaveBeenCalledTimes(1)
    expect(searchSessions.mock.calls[0]?.[0]).toMatchObject({
      query: 'alpha',
      tier: 'conversation',
      refresh: false
    })
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_SETTLED_DELAY_MS - AI_VAULT_SEARCH_TYPING_DELAY_MS)
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(searchSessions.mock.calls[1]?.[0]).toMatchObject({ query: 'alpha', tier: 'full' })
    expect(searchSessions.mock.calls[1]?.[0]).not.toHaveProperty('refresh')
  })

  it('restarts the debounce when the query changes mid-flight', () => {
    const { rerender } = renderHook(
      ({ query }: { query: string }) => useAiVaultSessionSearchRequest(argsFor(query)),
      { initialProps: { query: 'al' }, wrapper }
    )
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_TYPING_DELAY_MS - 10)
    })
    rerender({ query: 'alp' })
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_TYPING_DELAY_MS - 10)
    })
    expect(searchSessions).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(searchSessions.mock.calls[0]?.[0]).toMatchObject({ query: 'alp' })
  })

  it('does not re-issue when the parent rebuilds an equal args object', () => {
    const { rerender } = renderHook(
      ({ query }: { query: string }) => useAiVaultSessionSearchRequest(argsFor(query)),
      { initialProps: { query: 'alpha' }, wrapper }
    )
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_SETTLED_DELAY_MS)
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
    rerender({ query: 'alpha' })
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_SETTLED_DELAY_MS)
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('drops a stale conversation-tier response that lands after the full tier', async () => {
    const resolvers: ((result: AiVaultSearchResult) => void)[] = []
    searchSessions.mockImplementation(
      () => new Promise<AiVaultSearchResult>((resolve) => resolvers.push(resolve))
    )
    const { result } = renderHook(() => useAiVaultSessionSearchRequest(argsFor('alpha')), {
      wrapper
    })
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_SETTLED_DELAY_MS)
    })
    expect(resolvers).toHaveLength(2)
    await act(async () => {
      resolvers[1]?.(searchResult('full'))
    })
    expect(result.current.result?.repairedTerms).toEqual(['full'])
    await act(async () => {
      resolvers[0]?.(searchResult('conversation'))
    })
    expect(result.current.result?.repairedTerms).toEqual(['full'])
    expect(result.current.loading).toBe(false)
  })

  it('drops a response for a query the user has already replaced', async () => {
    const resolvers: ((result: AiVaultSearchResult) => void)[] = []
    searchSessions.mockImplementation(
      () => new Promise<AiVaultSearchResult>((resolve) => resolvers.push(resolve))
    )
    const { rerender, result } = renderHook(
      ({ query }: { query: string }) => useAiVaultSessionSearchRequest(argsFor(query)),
      { initialProps: { query: 'alpha' }, wrapper }
    )
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_TYPING_DELAY_MS)
    })
    rerender({ query: 'beta' })
    await act(async () => {
      resolvers[0]?.(searchResult('alpha'))
    })
    expect(result.current.result).toBeNull()
    expect(result.current.loading).toBe(true)
  })

  it('reports no search and no request for an empty query', () => {
    const { result } = renderHook(() => useAiVaultSessionSearchRequest(null), { wrapper })
    act(() => {
      vi.advanceTimersByTime(AI_VAULT_SEARCH_SETTLED_DELAY_MS)
    })
    expect(searchSessions).not.toHaveBeenCalled()
    expect(result.current).toEqual({ result: null, loading: false, error: null })
  })
})
