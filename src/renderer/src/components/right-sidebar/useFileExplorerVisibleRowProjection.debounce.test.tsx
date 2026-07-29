// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'
import { FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS } from './use-file-explorer-ignored-paths'

const getRuntimeGitIgnoredPathsMock = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitIgnoredPaths: getRuntimeGitIgnoredPathsMock
}))

const initialAppState = useAppStore.getInitialState()
const relativePaths = Array.from({ length: 5_000 }, (_, index) => `src/generated-${index}.ts`)

function useProjection(query: string) {
  return useFileExplorerVisibleRowProjection('worktree-1', '/repo', {}, new Set(), true, true, {
    query,
    relativePaths
  })
}

function useTreeProjection() {
  return useFileExplorerVisibleRowProjection(
    'worktree-1',
    '/repo',
    {
      '/repo': {
        children: [
          {
            name: 'src',
            path: '/repo/src',
            relativePath: 'src',
            isDirectory: true,
            depth: 0
          }
        ],
        loading: false
      }
    },
    new Set(),
    true,
    true,
    null
  )
}

describe('file explorer ignored-path query debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getRuntimeGitIgnoredPathsMock.mockReset().mockResolvedValue([])
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
    vi.useRealTimers()
  })

  it('coalesces a broad typing burst into one final ignored-path request', async () => {
    const hook = renderHook(({ query }) => useProjection(query), {
      initialProps: { query: 's' }
    })

    await act(async () => vi.advanceTimersByTimeAsync(100))
    hook.rerender({ query: 'sr' })
    await act(async () => vi.advanceTimersByTimeAsync(100))
    hook.rerender({ query: 'src' })

    await act(async () => vi.advanceTimersByTimeAsync(FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS - 1))
    expect(getRuntimeGitIgnoredPathsMock).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[0]?.[1]).toHaveLength(relativePaths.length)
  })

  it('cancels the pending ignored-path request when the explorer unmounts', async () => {
    const hook = renderHook(() => useProjection('src'))
    hook.unmount()

    await act(async () => vi.advanceTimersByTimeAsync(FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS))
    expect(getRuntimeGitIgnoredPathsMock).not.toHaveBeenCalled()
  })

  it('keeps ordinary expanded-tree ignored checks immediate', () => {
    renderHook(() => useTreeProjection())

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[0]?.[1]).toEqual(['src'])
  })
})
