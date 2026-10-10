// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../../shared/code-search-types'
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
  useAppStore: Object.assign(
    vi.fn((selector: (state: ReturnType<typeof mocks.getState>) => unknown) =>
      selector(mocks.getState())
    ),
    { getState: mocks.getState }
  )
}))

const RESULTS: SearchResult = {
  files: [],
  totalMatches: 0,
  truncated: false
}

function renderSearchRunner(state: Record<string, unknown>, worktreeId: string) {
  const updates: Record<string, unknown>[] = []
  mocks.getState.mockImplementation(() => state)
  mocks.searchRuntimeFiles.mockResolvedValue(RESULTS)

  const hook = renderHook(() =>
    useFileSearchRunner({
      activeWorktreeId: worktreeId,
      worktreePath: '/repo',
      updateActiveSearchState: (update) => updates.push(update)
    })
  )

  return { hook, updates }
}

async function finishSearch(executeSearch: (query: string) => void): Promise<void> {
  await act(async () => {
    executeSearch('owner')
    await vi.advanceTimersByTimeAsync(300)
  })
}

describe('useFileSearchRunner result ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionId.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
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

    await finishSearch(hook.result.current.executeSearch)

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
        runtimeEnvironmentId: 'search-runtime-a',
        rootPath: '/repo',
        executionHostId: 'runtime:search-runtime-a'
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

    await finishSearch(hook.result.current.executeSearch)

    expect(mocks.searchRuntimeFiles).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { activeRuntimeEnvironmentId: null }, worktreeId }),
      expect.any(Object),
      expect.any(AbortSignal)
    )
    expect(updates).toContainEqual({
      results: RESULTS,
      resultOwner: {
        worktreeId,
        runtimeEnvironmentId: null,
        rootPath: '/repo',
        executionHostId: 'local'
      }
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

    await finishSearch(hook.result.current.executeSearch)

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
      resultOwner: {
        worktreeId,
        runtimeEnvironmentId: null,
        rootPath: '/repo',
        executionHostId: 'ssh:ssh-target'
      }
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

    await finishSearch(hook.result.current.executeSearch)

    expect(updates).toContainEqual({
      results: RESULTS,
      resultOwner: {
        worktreeId,
        runtimeEnvironmentId: null,
        rootPath: '/repo',
        executionHostId: 'local'
      }
    })
  })

  it('shows an active failure and clears it when the next search succeeds or is empty', async () => {
    const worktreeId = 'missing-repo::/repo'
    const { hook, updates } = renderSearchRunner(
      { settings: {}, repos: [], worktreesByRepo: {}, fileSearchStateByWorktree: {} },
      worktreeId
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.searchRuntimeFiles.mockRejectedValueOnce(
      new Error("Error invoking remote method 'search': Error: regex parse error\nUnclosed group")
    )
    await finishSearch(hook.result.current.executeSearch)
    expect(Object.assign({}, ...updates)).toMatchObject({
      error: 'regex parse error\nUnclosed group',
      results: null,
      loading: false
    })

    await finishSearch(hook.result.current.executeSearch)
    expect(Object.assign({}, ...updates)).toMatchObject({ error: null, results: RESULTS })
    act(() => hook.result.current.executeSearch(''))
    expect(Object.assign({}, ...updates)).toMatchObject({ error: null, results: null })
    log.mockRestore()
  })

  it('ignores an older rejection after a newer search has succeeded', async () => {
    const { hook, updates } = renderSearchRunner(
      { settings: {}, repos: [], worktreesByRepo: {}, fileSearchStateByWorktree: {} },
      'missing-repo::/repo'
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectOldSearch: (reason: Error) => void = () => {}
    mocks.searchRuntimeFiles.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOldSearch = reject
        })
    )
    await finishSearch(hook.result.current.executeSearch)
    await finishSearch(hook.result.current.executeSearch)
    await act(async () => rejectOldSearch(new Error('old failure')))
    expect(Object.assign({}, ...updates)).toMatchObject({
      error: null,
      results: RESULTS,
      loading: false
    })
    expect(updates.some((update) => update.error === 'old failure')).toBe(false)
    log.mockRestore()
  })
})

it('aborts 99 superseded searches, preserves the latest result and stops the final search on unmount', async () => {
  vi.useFakeTimers()
  try {
    const worktreeId = 'repo-a::/repo'
    const { hook, updates } = renderSearchRunner(
      {
        settings: {},
        repos: [],
        worktreesByRepo: {},
        fileSearchStateByWorktree: { [worktreeId]: {} }
      },
      worktreeId
    )
    const signals: AbortSignal[] = []
    const completions: ((result: SearchResult) => void)[] = []
    mocks.searchRuntimeFiles.mockImplementation((_context, _options, signal: AbortSignal) => {
      signals.push(signal ?? new AbortController().signal)
      return new Promise<SearchResult>((resolve) => completions.push(resolve))
    })
    for (let index = 0; index < 100; index++) {
      await act(async () => {
        hook.result.current.executeSearch(`query-${index}`)
        await vi.advanceTimersByTimeAsync(300)
      })
    }
    expect(signals.filter((signal) => !signal.aborted)).toHaveLength(1)
    const stale: SearchResult = { files: [], totalMatches: 99, truncated: false }
    await act(async () => {
      completions[0](stale)
      completions[99](RESULTS)
    })
    expect(updates.some((update) => update.results === stale)).toBe(false)
    expect(updates.some((update) => update.results === RESULTS)).toBe(true)
    await act(async () => {
      hook.result.current.executeSearch('last')
      await vi.advanceTimersByTimeAsync(300)
    })
    hook.unmount()
    expect(signals.filter((signal) => !signal.aborted)).toHaveLength(1) // The already completed request is no longer owned.
    expect(signals[100].aborted).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('aborts the old root when a workspace path changes without changing its id', async () => {
  vi.useFakeTimers()
  try {
    mocks.getState.mockReturnValue({
      settings: {},
      repos: [],
      worktreesByRepo: {},
      fileSearchStateByWorktree: {}
    })
    const updateActiveSearchState = vi.fn()
    const signals: AbortSignal[] = []
    mocks.searchRuntimeFiles.mockImplementation((_context, _options, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise(() => {})
    })
    const hook = renderHook(
      ({ path }) =>
        useFileSearchRunner({
          activeWorktreeId: 'folder:stable',
          worktreePath: path,
          updateActiveSearchState
        }),
      { initialProps: { path: '/old-root' } }
    )
    await finishSearch(hook.result.current.executeSearch)
    hook.rerender({ path: '/new-root' })
    expect(signals[0].aborted).toBe(true)
    await finishSearch(hook.result.current.executeSearch)
    expect(mocks.searchRuntimeFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ worktreePath: '/new-root' }),
      expect.objectContaining({ rootPath: '/new-root' }),
      signals[1]
    )
    expect(signals[1].aborted).toBe(false)
    hook.unmount()
    expect(signals[1].aborted).toBe(true)
  } finally {
    vi.useRealTimers()
    vi.clearAllMocks()
  }
})
