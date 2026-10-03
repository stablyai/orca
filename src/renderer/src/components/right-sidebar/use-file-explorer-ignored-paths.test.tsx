// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerIgnoredPaths } from './use-file-explorer-ignored-paths'

const getRuntimeGitIgnoredPathsMock = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitIgnoredPaths: getRuntimeGitIgnoredPathsMock
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => undefined
}))
vi.mock('./file-explorer-runtime-owner', () => ({
  getRightSidebarWorktreeRuntimeSettings: () => ({ activeRuntimeEnvironmentId: null })
}))

const initialProps = {
  activeWorktreeId: 'worktree-1',
  worktreePath: '/repo',
  relativePaths: ['.DS_Store', '.agents']
}

function useIgnoredPaths(props: typeof initialProps) {
  return useFileExplorerIgnoredPaths({
    ...props,
    canLoadIgnoredPaths: true,
    shouldDebounceIgnoredQuery: false
  })
}

describe('file explorer ignored-path query failures', () => {
  beforeEach(() => {
    getRuntimeGitIgnoredPathsMock.mockReset()
  })

  afterEach(cleanup)

  it('preserves decorations after a failed refresh and accepts a later empty success', async () => {
    getRuntimeGitIgnoredPathsMock.mockResolvedValueOnce(['.DS_Store', '.agents'])
    const hook = renderHook(useIgnoredPaths, { initialProps })
    await act(async () => {})
    expect(hook.result.current).toEqual(['.DS_Store', '.agents'])

    getRuntimeGitIgnoredPathsMock.mockRejectedValueOnce(new Error('Git query failed'))
    await act(async () => {
      hook.rerender({ ...initialProps, relativePaths: [...initialProps.relativePaths, 'src'] })
    })
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(2)
    expect(hook.result.current).toEqual(['.DS_Store', '.agents'])

    getRuntimeGitIgnoredPathsMock.mockResolvedValueOnce([])
    await act(async () => {
      hook.rerender(initialProps)
    })
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(3)
    expect(hook.result.current).toEqual([])
  })

  it.each([
    { activeWorktreeId: 'worktree-2', worktreePath: '/repo' },
    { activeWorktreeId: 'worktree-1', worktreePath: '/other-repo' }
  ])('does not carry decorations into a failing new context: %j', async (context) => {
    getRuntimeGitIgnoredPathsMock.mockResolvedValueOnce(['.DS_Store'])
    const hook = renderHook(useIgnoredPaths, { initialProps })
    await act(async () => {})
    expect(hook.result.current).toEqual(['.DS_Store'])

    getRuntimeGitIgnoredPathsMock.mockRejectedValueOnce(new Error('Host unavailable'))
    await act(async () => {
      hook.rerender({ ...initialProps, ...context })
    })
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(2)
    expect(hook.result.current).toEqual([])
  })

  it('keeps an empty state when the first query fails', async () => {
    getRuntimeGitIgnoredPathsMock.mockRejectedValueOnce(new Error('Host unavailable'))
    const hook = renderHook(useIgnoredPaths, { initialProps })
    await act(async () => {})
    expect(hook.result.current).toEqual([])
  })

  it('does not let a late failure replace a newer successful query', async () => {
    let rejectOldQuery!: (error: Error) => void
    getRuntimeGitIgnoredPathsMock.mockReturnValueOnce(
      new Promise<string[]>((_resolve, reject) => {
        rejectOldQuery = reject
      })
    )
    const hook = renderHook(useIgnoredPaths, { initialProps })

    getRuntimeGitIgnoredPathsMock.mockResolvedValueOnce(['.DS_Store'])
    await act(async () => {
      hook.rerender({ ...initialProps, relativePaths: ['.DS_Store'] })
    })
    expect(hook.result.current).toEqual(['.DS_Store'])

    await act(async () => {
      rejectOldQuery(new Error('Late failure'))
    })
    expect(hook.result.current).toEqual(['.DS_Store'])
  })
})
