// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../../shared/types'
import { useFileSearchRunner } from './useFileSearchRunner'

const mocks = vi.hoisted(() => ({
  getConnectionId: vi.fn(),
  getState: vi.fn(),
  searchRuntimeFiles: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  searchRuntimeFiles: mocks.searchRuntimeFiles
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: mocks.getState })
}))

const RESULTS: SearchResult = {
  files: [],
  totalMatches: 0,
  truncated: false
}

type SearchRunnerProps = {
  activeWorktreeId: string
  worktreePath: string
}

function renderSearchRunner(state: Record<string, unknown>, worktreeId: string) {
  const updates: Record<string, unknown>[] = []
  const updateActiveSearchState = (update: Record<string, unknown>): void => {
    updates.push(update)
  }
  mocks.getState.mockImplementation(() => state)
  mocks.searchRuntimeFiles.mockResolvedValue(RESULTS)

  const hook = renderHook(
    ({ activeWorktreeId, worktreePath }: SearchRunnerProps) =>
      useFileSearchRunner({
        activeWorktreeId,
        worktreePath,
        updateActiveSearchState
      }),
    { initialProps: { activeWorktreeId: worktreeId, worktreePath: '/repo' } }
  )

  return { hook, updates }
}

async function startSearch(executeSearch: (query: string) => void, query = 'owner'): Promise<void> {
  await act(async () => {
    executeSearch(query)
    await vi.advanceTimersByTimeAsync(300)
  })
}

function mockPendingSearches(): AbortSignal[] {
  const signals: AbortSignal[] = []
  mocks.searchRuntimeFiles.mockImplementation(
    (_context: unknown, _options: unknown, signal?: AbortSignal): Promise<SearchResult> => {
      if (!signal) {
        return Promise.reject(new Error('Expected an abort signal'))
      }
      signals.push(signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('Search aborted')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true }
        )
      })
    }
  )
  return signals
}

function makeSearchState(...worktreeIds: string[]): Record<string, unknown> {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    repos: [],
    worktreesByRepo: {},
    fileSearchStateByWorktree: Object.fromEntries(worktreeIds.map((id) => [id, {}]))
  }
}

describe('useFileSearchRunner result ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionId.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('commits the explicit remote owner used for the search, not the ambient runtime', async () => {
    const worktreeId = 'repo-a::/repo'
    const state = {
      settings: { activeRuntimeEnvironmentId: 'ambient-runtime-b' },
      repos: [{ id: 'repo-a', executionHostId: 'runtime:repo-runtime' }],
      worktreesByRepo: {
        'repo-a': [{ id: worktreeId, repoId: 'repo-a', hostId: 'runtime:search-runtime-a' }]
      },
      fileSearchStateByWorktree: { [worktreeId]: {} }
    }
    const { hook, updates } = renderSearchRunner(state, worktreeId)

    await startSearch(hook.result.current.executeSearch)

    expect(mocks.searchRuntimeFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { activeRuntimeEnvironmentId: 'search-runtime-a' },
        worktreeId
      }),
      expect.any(Object),
      expect.any(AbortSignal)
    )
    expect(updates).toContainEqual({
      results: RESULTS,
      resultOwner: {
        worktreeId,
        runtimeEnvironmentId: 'search-runtime-a'
      }
    })
  })

  it('commits explicit local ownership without inheriting an ambient runtime', async () => {
    const worktreeId = 'repo-a::/repo'
    const state = {
      settings: { activeRuntimeEnvironmentId: 'ambient-runtime-b' },
      repos: [{ id: 'repo-a', executionHostId: 'runtime:repo-runtime' }],
      worktreesByRepo: {
        'repo-a': [{ id: worktreeId, repoId: 'repo-a', hostId: 'local' }]
      },
      fileSearchStateByWorktree: { [worktreeId]: {} }
    }
    const { hook, updates } = renderSearchRunner(state, worktreeId)

    await startSearch(hook.result.current.executeSearch)

    expect(mocks.searchRuntimeFiles).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { activeRuntimeEnvironmentId: null }, worktreeId }),
      expect.any(Object),
      expect.any(AbortSignal)
    )
    expect(updates).toContainEqual({
      results: RESULTS,
      resultOwner: { worktreeId, runtimeEnvironmentId: null }
    })
  })

  it('preserves SSH routing through the worktree connection without a runtime owner', async () => {
    const worktreeId = 'repo-a::/repo'
    const state = {
      settings: { activeRuntimeEnvironmentId: 'ambient-runtime-b' },
      repos: [{ id: 'repo-a', connectionId: 'ssh-target' }],
      worktreesByRepo: {
        'repo-a': [{ id: worktreeId, repoId: 'repo-a', hostId: 'ssh:ssh-target' }]
      },
      fileSearchStateByWorktree: { [worktreeId]: {} }
    }
    mocks.getConnectionId.mockReturnValue('ssh-target')
    const { hook, updates } = renderSearchRunner(state, worktreeId)

    await startSearch(hook.result.current.executeSearch)

    expect(mocks.searchRuntimeFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId,
        connectionId: 'ssh-target'
      }),
      expect.any(Object),
      expect.any(AbortSignal)
    )
    expect(updates).toContainEqual({
      results: RESULTS,
      resultOwner: { worktreeId, runtimeEnvironmentId: null }
    })
  })

  it('keeps an unresolved owner local when no runtime actually handled the search', async () => {
    const worktreeId = 'missing-repo::/repo'
    const state = {
      settings: { activeRuntimeEnvironmentId: null },
      repos: [],
      worktreesByRepo: {},
      fileSearchStateByWorktree: { [worktreeId]: {} }
    }
    const { hook, updates } = renderSearchRunner(state, worktreeId)

    await startSearch(hook.result.current.executeSearch)

    expect(updates).toContainEqual({
      results: RESULTS,
      resultOwner: { worktreeId, runtimeEnvironmentId: null }
    })
  })
})

describe('useFileSearchRunner cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionId.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('keeps only the newest of 100 started searches live', async () => {
    const worktreeId = 'repo-a::/repo'
    const { hook } = renderSearchRunner(makeSearchState(worktreeId), worktreeId)
    const signals = mockPendingSearches()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    for (let index = 0; index < 100; index += 1) {
      await startSearch(hook.result.current.executeSearch, `owner-${index}`)
    }

    expect(mocks.searchRuntimeFiles).toHaveBeenCalledTimes(100)
    expect(signals.filter((signal) => signal.aborted)).toHaveLength(99)
    expect(signals.at(-1)?.aborted).toBe(false)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('aborts the active search when Clear cancels pending work', async () => {
    const worktreeId = 'repo-a::/repo'
    const { hook, updates } = renderSearchRunner(makeSearchState(worktreeId), worktreeId)
    const signals = mockPendingSearches()

    await startSearch(hook.result.current.executeSearch)
    let didCancel = false
    act(() => {
      didCancel = hook.result.current.cancelPendingSearch()
    })

    expect(didCancel).toBe(true)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(updates.at(-1)).toEqual({ loading: false })
  })

  it('reports canceled debounce work only once', () => {
    const worktreeId = 'repo-a::/repo'
    const { hook } = renderSearchRunner(makeSearchState(worktreeId), worktreeId)

    act(() => hook.result.current.executeSearch('pending'))
    let firstCancellation = false
    let secondCancellation = true
    act(() => {
      firstCancellation = hook.result.current.cancelPendingSearch()
      secondCancellation = hook.result.current.cancelPendingSearch()
    })

    expect(firstCancellation).toBe(true)
    expect(secondCancellation).toBe(false)
    expect(mocks.searchRuntimeFiles).not.toHaveBeenCalled()
  })

  it('reports no pending work after a search completes', async () => {
    const worktreeId = 'repo-a::/repo'
    const { hook } = renderSearchRunner(makeSearchState(worktreeId), worktreeId)

    await startSearch(hook.result.current.executeSearch)
    let didCancel = true
    act(() => {
      didCancel = hook.result.current.cancelPendingSearch()
    })

    expect(didCancel).toBe(false)
  })

  it('aborts the active search on unmount', async () => {
    const worktreeId = 'repo-a::/repo'
    const { hook } = renderSearchRunner(makeSearchState(worktreeId), worktreeId)
    const signals = mockPendingSearches()

    await startSearch(hook.result.current.executeSearch)
    await act(async () => {
      hook.unmount()
      await Promise.resolve()
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('aborts the active search when the worktree changes', async () => {
    const firstWorktreeId = 'repo-a::/repo-a'
    const secondWorktreeId = 'repo-b::/repo-b'
    const { hook } = renderSearchRunner(
      makeSearchState(firstWorktreeId, secondWorktreeId),
      firstWorktreeId
    )
    const signals = mockPendingSearches()

    await startSearch(hook.result.current.executeSearch)
    await act(async () => {
      hook.rerender({ activeWorktreeId: secondWorktreeId, worktreePath: '/repo-b' })
      await Promise.resolve()
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('treats AbortError as silent cancellation', async () => {
    const worktreeId = 'repo-a::/repo'
    const { hook, updates } = renderSearchRunner(makeSearchState(worktreeId), worktreeId)
    const error = new Error('Search aborted')
    error.name = 'AbortError'
    mocks.searchRuntimeFiles.mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await startSearch(hook.result.current.executeSearch)

    expect(consoleError).not.toHaveBeenCalled()
    expect(updates.filter((update) => 'results' in update)).toEqual([])
    expect(updates.at(-1)).toEqual({ loading: false })
  })
})
