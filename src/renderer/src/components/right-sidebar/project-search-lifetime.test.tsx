// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../../shared/ai-vault-search-client'
import { searchHit, searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import type { AiVaultSearchRequest } from '../../../../shared/ai-vault-search-types'
import { useAiVaultSearch } from './use-ai-vault-search'

afterEach(() => vi.useRealTimers())

it('retires the direct Project chain before new work and allows one stale restart with finite continuation', async () => {
  vi.useFakeTimers()
  let release: () => void = () => {}
  let statusHeld = true
  const statusReady = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let stale = true
  const client = createSessionSearchClient(async (method, params) => {
    calls.push({ method, params })
    if (method === 'aiVault.searchStatus') {
      if (statusHeld) {
        await statusReady
      }
      return { ...unavailableSessionSearchStatus(), supportedAgents: ['codex'] }
    }
    if (params.cursor && stale) {
      stale = false
      return { kind: 'stale-cursor', generation: 2 }
    }
    return {
      ...searchResults(),
      hits: [{ ...searchHit(), agent: 'codex', sessionId: params.cursor ? 'second' : 'first' }],
      page: { cursor: params.cursor ? null : 'next', hasMore: !params.cursor }
    }
  }, 'relay')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        searchSessions: (request: AiVaultSearchRequest, _scope?: string, active?: () => boolean) =>
          client.searchSessions(request, active)
      }
    }
  })
  const request: AiVaultSearchRequest = {
    query: 'needle',
    filters: { agents: ['codex'] },
    within: { kind: 'project', projectKey: 'project:P', canonicalProjectKey: 'repo:b' }
  }
  const retired = renderHook(() => useAiVaultSearch(request, 'runtime:old', ''))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(calls.map((call) => call.method)).toEqual(['aiVault.searchStatus'])
  retired.unmount()
  statusHeld = false
  await act(async () => {
    release()
    await statusReady
  })
  expect(calls).toHaveLength(1)
  const live = renderHook(() => useAiVaultSearch(request, 'runtime:old', ''))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  await act(async () => {
    live.result.current.loadMore()
  })
  expect(live.result.current.hits.map((hit) => hit.sessionId)).toEqual(['first'])
  await act(async () => {
    live.result.current.loadMore()
  })
  expect(live.result.current.hits.map((hit) => hit.sessionId)).toEqual(['first', 'second'])
  expect(live.result.current.response).toMatchObject({ kind: 'results', page: { hasMore: false } })
  expect(
    calls
      .filter((call) => call.method === 'aiVault.searchSessions')
      .map((call) => call.params.cursor)
  ).toEqual([undefined, 'next', undefined, 'next'])
  for (const call of calls.filter((call) => call.method === 'aiVault.searchSessions')) {
    expect(call.params.within).toEqual(request.within)
  }
  live.unmount()
})
