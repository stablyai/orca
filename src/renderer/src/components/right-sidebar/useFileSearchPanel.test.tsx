// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import type { ChangeEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../../shared/types'
import { useFileSearchPanel } from './useFileSearchPanel'

type FileSearchState = {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  includePattern: string
  excludePattern: string
  results: SearchResult | null
  resultOwner: unknown
  loading: boolean
  collapsedFiles: Set<string>
  seedRequestId?: number
}

type MockStoreState = {
  activeWorktreeId: string | null
  fileSearchStateByWorktree: Record<string, FileSearchState>
  openFile: () => void
  setPendingEditorReveal: () => void
  updateFileSearchState: (worktreeId: string, updates: Partial<FileSearchState>) => void
  consumeFileSearchSeedRequest: (worktreeId: string, requestId: number) => void
  toggleFileSearchCollapsedFile: () => void
  clearFileSearch: (worktreeId: string) => void
}

const WORKTREE_ID = 'repo-a::/repo'
const SECOND_WORKTREE_ID = 'repo-b::/other'
const RESULTS_A: SearchResult = { files: [], totalMatches: 1, truncated: false }
const RESULTS_B: SearchResult = { files: [], totalMatches: 2, truncated: false }

const mocks = vi.hoisted(() => ({
  activeWorktree: null as { id: string; path: string } | null,
  getConnectionId: vi.fn(),
  getRuntimeSettings: vi.fn(),
  searchRuntimeFiles: vi.fn(),
  state: null as unknown as MockStoreState
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  searchRuntimeFiles: mocks.searchRuntimeFiles
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: MockStoreState) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => mocks.activeWorktree
}))

vi.mock('./file-explorer-runtime-owner', () => ({
  getRightSidebarWorktreeRuntimeSettings: mocks.getRuntimeSettings
}))

function makeFileSearchState(query = 'alpha'): FileSearchState {
  return {
    query,
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    includePattern: '',
    excludePattern: '',
    results: RESULTS_A,
    resultOwner: null,
    loading: false,
    collapsedFiles: new Set()
  }
}

function resetStore(): void {
  mocks.state = {
    activeWorktreeId: WORKTREE_ID,
    fileSearchStateByWorktree: { [WORKTREE_ID]: makeFileSearchState() },
    openFile: vi.fn(),
    setPendingEditorReveal: vi.fn(),
    updateFileSearchState: vi.fn((worktreeId, updates) => {
      Object.assign(mocks.state.fileSearchStateByWorktree[worktreeId], updates)
    }),
    consumeFileSearchSeedRequest: vi.fn((worktreeId) => {
      delete mocks.state.fileSearchStateByWorktree[worktreeId]?.seedRequestId
    }),
    toggleFileSearchCollapsedFile: vi.fn(),
    clearFileSearch: vi.fn((worktreeId) => {
      mocks.state.fileSearchStateByWorktree[worktreeId] = makeFileSearchState('')
    })
  }
}

function queryChange(value: string): ChangeEvent<HTMLInputElement> {
  return { target: { value } } as ChangeEvent<HTMLInputElement>
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

type PanelProps = { explorerView: 'files' | 'search' }

function renderPanel() {
  const initialProps: PanelProps = { explorerView: 'search' }
  return renderHook(({ explorerView }: PanelProps) => useFileSearchPanel(explorerView), {
    initialProps
  })
}

describe('useFileSearchPanel interrupted searches', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetStore()
    mocks.activeWorktree = { id: WORKTREE_ID, path: '/repo' }
    mocks.getConnectionId.mockReturnValue(null)
    mocks.getRuntimeSettings.mockReturnValue({ activeRuntimeEnvironmentId: null })
    mocks.searchRuntimeFiles.mockResolvedValue(RESULTS_B)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('restarts the current query after canceling its debounce on Files view', async () => {
    const hook = renderPanel()

    act(() => hook.result.current.queryRowProps.onQueryChange(queryChange('beta')))
    hook.rerender({ explorerView: 'search' })
    hook.rerender({ explorerView: 'files' })
    expect(mocks.state.fileSearchStateByWorktree[WORKTREE_ID].results).toBeNull()
    hook.rerender({ explorerView: 'search' })

    await act(async () => vi.advanceTimersByTimeAsync(299))
    expect(mocks.searchRuntimeFiles).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(mocks.searchRuntimeFiles).toHaveBeenCalledTimes(1)
    expect(mocks.searchRuntimeFiles).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ query: 'beta' }),
      expect.any(AbortSignal)
    )
  })

  it('aborts an in-flight query and keeps its replacement live on re-entry', async () => {
    const hook = renderPanel()
    const signals = mockPendingSearches()

    act(() => hook.result.current.queryRowProps.onQueryChange(queryChange('beta')))
    hook.rerender({ explorerView: 'search' })
    await act(async () => vi.advanceTimersByTimeAsync(300))

    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)

    hook.rerender({ explorerView: 'files' })
    await act(() => Promise.resolve())
    hook.rerender({ explorerView: 'search' })
    await act(async () => vi.advanceTimersByTimeAsync(300))

    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
  })

  it('discards prior-query results when unmount interrupts a search', async () => {
    const hook = renderPanel()
    const signals = mockPendingSearches()

    act(() => hook.result.current.queryRowProps.onQueryChange(queryChange('beta')))
    hook.rerender({ explorerView: 'search' })
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(mocks.state.fileSearchStateByWorktree[WORKTREE_ID].results).toBe(RESULTS_A)

    await act(async () => {
      hook.unmount()
      await Promise.resolve()
    })

    expect(signals[0]?.aborted).toBe(true)
    expect(mocks.state.fileSearchStateByWorktree[WORKTREE_ID]).toMatchObject({
      query: 'beta',
      results: null,
      resultOwner: null,
      loading: false
    })
    const reopened = renderPanel()
    expect(reopened.result.current.resultsProps.results).toBeNull()
  })

  it('discards prior-query results across a worktree round-trip', async () => {
    const hook = renderPanel()
    const signals = mockPendingSearches()

    act(() => hook.result.current.queryRowProps.onQueryChange(queryChange('beta')))
    hook.rerender({ explorerView: 'search' })
    await act(async () => vi.advanceTimersByTimeAsync(300))

    mocks.state.fileSearchStateByWorktree[SECOND_WORKTREE_ID] = makeFileSearchState('other')
    mocks.state.activeWorktreeId = SECOND_WORKTREE_ID
    mocks.activeWorktree = { id: SECOND_WORKTREE_ID, path: '/other' }
    hook.rerender({ explorerView: 'search' })
    mocks.state.activeWorktreeId = WORKTREE_ID
    mocks.activeWorktree = { id: WORKTREE_ID, path: '/repo' }
    hook.rerender({ explorerView: 'search' })

    expect(signals[0]?.aborted).toBe(true)
    expect(mocks.state.fileSearchStateByWorktree[WORKTREE_ID].results).toBeNull()
    expect(hook.result.current.resultsProps.results).toBeNull()
  })

  it('reuses completed results without starting another search', async () => {
    const hook = renderPanel()

    act(() => hook.result.current.queryRowProps.onQueryChange(queryChange('beta')))
    hook.rerender({ explorerView: 'search' })
    await act(async () => vi.advanceTimersByTimeAsync(300))
    hook.rerender({ explorerView: 'search' })

    expect(hook.result.current.resultsProps.results).toBe(RESULTS_B)
    expect(mocks.searchRuntimeFiles).toHaveBeenCalledTimes(1)

    hook.rerender({ explorerView: 'files' })
    hook.rerender({ explorerView: 'search' })
    await act(async () => vi.advanceTimersByTimeAsync(300))

    expect(hook.result.current.resultsProps.results).toBe(RESULTS_B)
    expect(mocks.searchRuntimeFiles).toHaveBeenCalledTimes(1)
  })

  it('drops resume ownership when the hidden query changes', async () => {
    const hook = renderPanel()

    act(() => hook.result.current.queryRowProps.onQueryChange(queryChange('beta')))
    hook.rerender({ explorerView: 'search' })
    hook.rerender({ explorerView: 'files' })

    mocks.state.fileSearchStateByWorktree[WORKTREE_ID].query = 'gamma'
    hook.rerender({ explorerView: 'files' })
    mocks.state.fileSearchStateByWorktree[WORKTREE_ID].query = 'beta'
    hook.rerender({ explorerView: 'files' })
    hook.rerender({ explorerView: 'search' })
    await act(async () => vi.advanceTimersByTimeAsync(300))

    expect(mocks.searchRuntimeFiles).not.toHaveBeenCalled()
  })

  it('drops resume ownership when the hidden worktree changes', async () => {
    const hook = renderPanel()

    act(() => hook.result.current.queryRowProps.onQueryChange(queryChange('beta')))
    hook.rerender({ explorerView: 'search' })
    hook.rerender({ explorerView: 'files' })

    mocks.state.fileSearchStateByWorktree[SECOND_WORKTREE_ID] = makeFileSearchState('beta')
    mocks.state.activeWorktreeId = SECOND_WORKTREE_ID
    mocks.activeWorktree = { id: SECOND_WORKTREE_ID, path: '/other' }
    hook.rerender({ explorerView: 'files' })
    mocks.state.activeWorktreeId = WORKTREE_ID
    mocks.activeWorktree = { id: WORKTREE_ID, path: '/repo' }
    hook.rerender({ explorerView: 'files' })
    hook.rerender({ explorerView: 'search' })
    await act(async () => vi.advanceTimersByTimeAsync(300))

    expect(mocks.searchRuntimeFiles).not.toHaveBeenCalled()
  })
})
