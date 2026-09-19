// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSessionFilterState } from '../../../../shared/ai-vault-session-filters'
import type { AiVaultSearchScope } from '../../../../shared/ai-vault-session-search-scope'
import { createAiVaultTestSession } from '../../../../shared/ai-vault-session-test-session'
import { useAiVaultSessionSearch } from './use-ai-vault-session-search'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const rankSessions = vi.fn()
const searchListedSessions = vi.fn()
const sessions = [
  createAiVaultTestSession({
    id: 'claude:1',
    title: 'Linux pairing notes'
  }),
  createAiVaultTestSession({
    id: 'claude:2',
    title: 'Windows path quoting'
  })
]
const agents = ['claude'] as const
const activeWorktreePaths: string[] = []

type HookState = ReturnType<typeof useAiVaultSessionSearch>

let latestState: HookState | null = null
const roots: Root[] = []

function HookProbe({
  query,
  searchScope,
  extraFilters
}: {
  query: string
  searchScope: AiVaultSearchScope
  extraFilters?: Partial<AiVaultSessionFilterState>
}): null {
  const filters: AiVaultSessionFilterState = {
    query,
    agents,
    scope: 'all',
    sort: 'updated',
    activeWorktreePaths,
    hideEmptySessions: true,
    searchScope,
    ...extraFilters
  }
  latestState = useAiVaultSessionSearch({
    sessions,
    filters,
    repoId: 'repo-1'
  })
  return null
}

async function renderHookProbe(
  query: string,
  searchScope: AiVaultSearchScope = 'title',
  extraFilters?: Partial<AiVaultSessionFilterState>
): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<HookProbe query={query} searchScope={searchScope} extraFilters={extraFilters} />)
  })
  return root
}

async function rerenderHookProbe(
  root: Root,
  query: string,
  searchScope: AiVaultSearchScope = 'title',
  extraFilters?: Partial<AiVaultSessionFilterState>
): Promise<void> {
  await act(async () => {
    root.render(<HookProbe query={query} searchScope={searchScope} extraFilters={extraFilters} />)
  })
}

function hookState(): HookState {
  if (!latestState) {
    throw new Error('Hook state has not been rendered')
  }
  return latestState
}

describe('useAiVaultSessionSearch live filter', () => {
  const originalApi = window.api

  beforeEach(() => {
    latestState = null
    rankSessions.mockReset()
    searchListedSessions.mockReset()
    rankSessions.mockResolvedValue({ ok: true, rankedIds: ['claude:2'], usedModel: true })
    searchListedSessions.mockResolvedValue({
      matchedIds: ['claude:1'],
      usedRg: true,
      usedFts: false,
      truncated: false,
      degraded: false,
      hits: []
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: happy-dom has no preload; this stub supplies only the vault methods the hook calls.
    window.api = {
      ...originalApi,
      aiVault: {
        ...originalApi?.aiVault,
        rankSessions,
        searchListedSessions
      }
    } as typeof window.api
  })

  afterEach(() => {
    vi.useRealTimers()
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    window.api = originalApi
  })

  it('filters the in-panel list from the local index as the query changes', async () => {
    const root = await renderHookProbe('')
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual([
      'claude:1',
      'claude:2'
    ])

    await rerenderHookProbe(root, 'pairing')

    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:1'])
    expect(rankSessions).not.toHaveBeenCalled()
    expect(searchListedSessions).not.toHaveBeenCalled()
    expect(hookState().usedModel).toBe(false)
  })

  it('debounces full-text retrieval through rg instead of the card index', async () => {
    vi.useFakeTimers()
    const root = await renderHookProbe('', 'full')
    await rerenderHookProbe(root, 'pairing', 'full')
    expect(searchListedSessions).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(searchListedSessions).toHaveBeenCalledTimes(1)
    expect(searchListedSessions.mock.calls[0]?.[0]).toMatchObject({
      query: 'pairing',
      searchScope: 'full'
    })
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:1'])
    expect(rankSessions).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('ranks the current in-panel query only when AI search is requested', async () => {
    await renderHookProbe('windows')
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:2'])
    expect(rankSessions).not.toHaveBeenCalled()

    await act(async () => {
      await hookState().runAiSearch()
    })

    expect(rankSessions).toHaveBeenCalledTimes(1)
    expect(rankSessions.mock.calls[0]?.[0]).toMatchObject({
      query: 'windows',
      repoId: 'repo-1'
    })
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:2'])
    expect(hookState().usedModel).toBe(true)
  })

  it('ignores a stale AI ranking after retrieval inputs change', async () => {
    let resolveRank:
      | ((value: { ok: true; rankedIds: string[]; usedModel: boolean }) => void)
      | undefined
    rankSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRank = resolve
        })
    )
    const root = await renderHookProbe('windows')

    await act(async () => {
      void hookState().runAiSearch()
    })
    expect(hookState().aiLoading).toBe(true)

    await rerenderHookProbe(root, 'pairing')
    expect(hookState().aiLoading).toBe(false)
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:1'])
    expect(hookState().usedModel).toBe(false)

    await act(async () => {
      resolveRank?.({ ok: true, rankedIds: ['claude:2'], usedModel: true })
    })

    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:1'])
    expect(hookState().usedModel).toBe(false)
  })

  it('applies only the latest full-text rg result when queries overlap', async () => {
    vi.useFakeTimers()
    const deferred: ((value: {
      matchedIds: string[]
      usedRg: boolean
      usedFts: boolean
      truncated: boolean
      degraded: boolean
      hits: []
    }) => void)[] = []
    searchListedSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.push(resolve)
        })
    )

    const root = await renderHookProbe('', 'full')
    await rerenderHookProbe(root, 'pairing', 'full')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(searchListedSessions).toHaveBeenCalledTimes(1)

    await rerenderHookProbe(root, 'windows', 'full')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(searchListedSessions).toHaveBeenCalledTimes(2)

    await act(async () => {
      deferred[1]?.({
        matchedIds: ['claude:2'],
        usedRg: true,
        usedFts: false,
        truncated: false,
        degraded: false,
        hits: []
      })
    })
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:2'])

    await act(async () => {
      deferred[0]?.({
        matchedIds: ['claude:1'],
        usedRg: true,
        usedFts: false,
        truncated: false,
        degraded: false,
        hits: []
      })
    })
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:2'])
    vi.useRealTimers()
  })

  it('clears a stale rg-unavailable fallback when the query changes', async () => {
    vi.useFakeTimers()
    searchListedSessions.mockResolvedValueOnce({
      matchedIds: [],
      usedRg: false,
      usedFts: false,
      truncated: false,
      degraded: false,
      hits: []
    })

    const root = await renderHookProbe('', 'full')
    await rerenderHookProbe(root, 'pairing', 'full')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual(['claude:1'])

    await rerenderHookProbe(root, 'transcriptonly', 'full')
    expect(hookState().filteredSessions.map((session) => session.id)).toEqual([
      'claude:1',
      'claude:2'
    ])
  })
})
