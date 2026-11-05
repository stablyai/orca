// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { useFileSearchPanel } from './useFileSearchPanel'
import type { SearchResult } from '../../../../../../shared/code-search-types'

const { search } = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock('@/runtime/runtime-file-search-client', () => ({ searchRuntimeFiles: search }))
const initial = useAppStore.getInitialState()

const empty: SearchResult = { files: [], totalMatches: 0, truncated: false }

beforeEach(() => {
  vi.useFakeTimers()
  search.mockReset()
  useAppStore.setState(
    {
      ...initial,
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'a', folderPath: '/a' }),
        makeFolderWorkspace({ id: 'b', folderPath: '/b' })
      ],
      activeWorktreeId: 'folder:a'
    },
    true
  )
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.useRealTimers()
})

it('automatically replaces pending root searches and ignores a late old completion', async () => {
  const signals: AbortSignal[] = []
  const completions: ((value: SearchResult) => void)[] = []
  search.mockImplementation((_context, _options, signal: AbortSignal) => {
    signals.push(signal)
    return new Promise<SearchResult>((resolve) => completions.push(resolve))
  })
  useAppStore.getState().updateFileSearchState('folder:a', { query: 'needle' })
  const hook = renderHook(() => useFileSearchPanel('search'))
  await act(async () => vi.advanceTimersByTimeAsync(300))
  await act(async () =>
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ id: 'a', folderPath: '/replacement' })]
    })
  )
  expect(signals[0].aborted).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(search).toHaveBeenCalledTimes(2)
  await act(async () => completions[1](empty))
  const replacementOwner = useAppStore.getState().fileSearchStateByWorktree['folder:a'].resultOwner
  await act(async () => completions[0]({ ...empty, totalMatches: 99 }))
  expect(useAppStore.getState().fileSearchStateByWorktree['folder:a'].results?.totalMatches).toBe(0)
  expect(useAppStore.getState().fileSearchStateByWorktree['folder:a'].resultOwner).toBe(
    replacementOwner
  )
  hook.unmount()
})

it('retries a saved failure after its root changes without reusing the old error', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    search.mockRejectedValueOnce(new Error('old root unavailable')).mockResolvedValue(empty)
    useAppStore.getState().updateFileSearchState('folder:a', { query: 'needle' })
    const hook = renderHook(() => useFileSearchPanel('search'))
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(useAppStore.getState().fileSearchStateByWorktree['folder:a'].error).toBe(
      'old root unavailable'
    )
    await act(async () =>
      useAppStore.setState({
        folderWorkspaces: [makeFolderWorkspace({ id: 'a', folderPath: '/replacement' })]
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(search).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().fileSearchStateByWorktree['folder:a'].error).toBeNull()
    expect(useAppStore.getState().fileSearchStateByWorktree['folder:a'].results).toEqual(empty)
    hook.unmount()
  } finally {
    log.mockRestore()
  }
})

it.each(['root', 'owner'] as const)(
  'hides stale errors during %s replacement before effects clear them',
  async (change) => {
    search.mockRejectedValue(new Error('current failure'))
    useAppStore.getState().updateFileSearchState('folder:a', { query: 'needle' })
    const renders: (string | null | undefined)[] = []
    const hook = renderHook(() => {
      const panel = useFileSearchPanel('search')
      renders.push(panel.resultsProps.error)
      return panel
    })
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(hook.result.current.resultsProps.error).toBe('current failure')
    renders.length = 0
    await act(async () =>
      useAppStore.setState({
        folderWorkspaces: [
          makeFolderWorkspace({
            id: 'a',
            folderPath: change === 'root' ? '/replacement' : '/a',
            connectionId: change === 'owner' ? 'remote' : null
          })
        ]
      })
    )
    expect(renders.length).toBeGreaterThan(0)
    expect(renders).not.toContain('current failure')
    hook.unmount()
  }
)
