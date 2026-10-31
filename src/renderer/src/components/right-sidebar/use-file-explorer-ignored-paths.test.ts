// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getRuntimeGitIgnoredPathsMock = vi.hoisted(() => vi.fn())
const getWorktreeGitOwnerTargetMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitIgnoredPaths: getRuntimeGitIgnoredPathsMock
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null
}))

vi.mock('./worktree-git-owner-target', () => ({
  getWorktreeGitOwnerTarget: getWorktreeGitOwnerTargetMock
}))

import {
  FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS,
  requestFileExplorerIgnoredPaths,
  useFileExplorerIgnoredPaths
} from './use-file-explorer-ignored-paths'

type IgnoredQueryDeferred = {
  promise: Promise<string[]>
  resolve: (paths: string[]) => void
}

function createIgnoredQueryDeferred(): IgnoredQueryDeferred {
  let resolve!: (paths: string[]) => void
  const promise = new Promise<string[]>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

let deferreds: IgnoredQueryDeferred[] = []

function renderIgnoredPathsHook(worktreeId: string, initialPaths: string[]) {
  return renderHook(
    ({ paths }: { paths: string[] }) => {
      return useFileExplorerIgnoredPaths({
        activeWorktreeId: worktreeId,
        canLoadIgnoredPaths: true,
        relativePaths: paths,
        shouldDebounceIgnoredQuery: false,
        worktreePath: `/repo/${worktreeId}`
      })
    },
    { initialProps: { paths: initialPaths } }
  )
}

describe('useFileExplorerIgnoredPaths', () => {
  beforeEach(() => {
    deferreds = []
    getRuntimeGitIgnoredPathsMock.mockReset()
    getRuntimeGitIgnoredPathsMock.mockImplementation(() => {
      const deferred = createIgnoredQueryDeferred()
      deferreds.push(deferred)
      return deferred.promise
    })
    getWorktreeGitOwnerTargetMock.mockReset()
    getWorktreeGitOwnerTargetMock.mockReturnValue({ kind: 'local' })
  })

  afterEach(() => {
    cleanup()
  })

  it('merges watcher-driven path changes into one in-flight query plus one trailing query', async () => {
    const { rerender } = renderIgnoredPathsHook('wt-merge', ['a.ts'])
    rerender({ paths: ['a.ts', 'b.ts'] })
    rerender({ paths: ['a.ts', 'b.ts', 'c.ts'] })

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferreds[0]?.resolve(['a.ts'])
    })

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(2)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[1]?.[1]).toEqual(['a.ts', 'b.ts', 'c.ts'])

    await act(async () => {
      deferreds[1]?.resolve(['a.ts', 'b.ts'])
    })
  })

  it('applies trailing verdicts covering every path that arrived while a query was in flight', async () => {
    const { result, rerender } = renderIgnoredPathsHook('wt-trailing', ['a.ts'])
    rerender({ paths: ['a.ts', 'b.ts'] })
    rerender({ paths: ['a.ts', 'b.ts', 'c.ts'] })

    await act(async () => {
      deferreds[0]?.resolve([])
    })
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      deferreds[1]?.resolve(['b.ts', 'c.ts'])
    })

    expect(result.current).toEqual(['b.ts', 'c.ts'])
  })

  it('gives every merged caller verdicts covering its own requested paths', async () => {
    const first = renderIgnoredPathsHook('wt-callers', ['a.ts'])
    const second = renderIgnoredPathsHook('wt-callers', ['b.ts'])

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[0]?.[1]).toEqual(['a.ts'])

    await act(async () => {
      deferreds[0]?.resolve(['a.ts'])
    })
    await act(async () => {
      deferreds[1]?.resolve(['b.ts'])
    })

    expect(first.result.current).toEqual(['a.ts'])
    expect(second.result.current).toEqual(['b.ts'])
  })

  it('drops pending merged paths when the caller unmounts so no trailing query fires', async () => {
    const { rerender, unmount } = renderIgnoredPathsHook('wt-unmount', ['a.ts'])
    rerender({ paths: ['a.ts', 'b.ts'] })
    unmount()

    await act(async () => {
      deferreds[0]?.resolve(['a.ts'])
    })

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the debounced quiet window before querying', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = renderHook(
        ({ paths }: { paths: string[] }) => {
          return useFileExplorerIgnoredPaths({
            activeWorktreeId: 'wt-debounce',
            canLoadIgnoredPaths: true,
            relativePaths: paths,
            shouldDebounceIgnoredQuery: true,
            worktreePath: '/repo/wt-debounce'
          })
        },
        { initialProps: { paths: ['a.ts'] } }
      )

      expect(getRuntimeGitIgnoredPathsMock).not.toHaveBeenCalled()

      rerender({ paths: ['a.ts', 'b.ts'] })
      act(() => {
        vi.advanceTimersByTime(FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS)
      })

      expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
      expect(getRuntimeGitIgnoredPathsMock.mock.calls[0]?.[1]).toEqual(['a.ts', 'b.ts'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a cancelled caller pending paths from the trailing query', async () => {
    const caller = renderIgnoredPathsHook('wt-cancelled-paths', ['seed.ts'])
    // The updated request lands in pending because the first query is still in flight.
    caller.rerender({ paths: ['a.ts'] })
    caller.unmount()

    renderIgnoredPathsHook('wt-cancelled-paths', ['b.ts'])

    await act(async () => {
      deferreds[0]?.resolve([])
    })

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(2)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[1]?.[1]).toEqual(['b.ts'])

    await act(async () => {
      deferreds[1]?.resolve(['b.ts'])
    })
  })

  it('does not settle a cancelled caller that joined the in-flight query', async () => {
    const context = {
      activeWorktreeId: 'wt-cancelled-inflight',
      connectionId: undefined,
      target: { kind: 'local' } as const,
      worktreePath: '/repo/wt-cancelled-inflight'
    }
    const firstOnSettled = vi.fn()
    const secondOnSettled = vi.fn()
    const cancelFirst = requestFileExplorerIgnoredPaths(context, ['a.ts'], firstOnSettled)
    const cancelSecond = requestFileExplorerIgnoredPaths(context, ['a.ts'], secondOnSettled)

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)

    cancelSecond()

    await act(async () => {
      deferreds[0]?.resolve(['a.ts'])
    })

    expect(firstOnSettled).toHaveBeenCalledWith(['a.ts'])
    expect(secondOnSettled).not.toHaveBeenCalled()

    cancelFirst()
  })

  it('gives each joined caller only the verdicts for its own requested paths', async () => {
    const first = renderIgnoredPathsHook('wt-subset-verdicts', ['a.ts', 'b.ts'])
    const second = renderIgnoredPathsHook('wt-subset-verdicts', ['b.ts'])
    const third = renderIgnoredPathsHook('wt-subset-verdicts', [])

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferreds[0]?.resolve(['a.ts'])
    })

    expect(first.result.current).toEqual(['a.ts'])
    expect(second.result.current).toEqual([])
    expect(third.result.current).toEqual([])
  })

  it('keeps a pending waiter on its own owner target when a later caller joins the in-flight query', async () => {
    getWorktreeGitOwnerTargetMock.mockReturnValue({
      kind: 'environment',
      environmentId: 'env-1'
    })
    const env1 = renderIgnoredPathsHook('wt-pending-identity', ['a.ts'])
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)

    getWorktreeGitOwnerTargetMock.mockReturnValue({
      kind: 'environment',
      environmentId: 'env-2'
    })
    const env2 = renderIgnoredPathsHook('wt-pending-identity', ['b.ts'])
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)

    getWorktreeGitOwnerTargetMock.mockReturnValue({
      kind: 'environment',
      environmentId: 'env-1'
    })
    renderIgnoredPathsHook('wt-pending-identity', ['a.ts'])
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferreds[0]?.resolve([])
    })

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(2)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[1]?.[0]?.target).toEqual({
      kind: 'environment',
      environmentId: 'env-2'
    })
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[1]?.[1]).toEqual(['b.ts'])

    await act(async () => {
      deferreds[1]?.resolve(['b.ts'])
    })

    expect(env1.result.current).toEqual([])
    expect(env2.result.current).toEqual(['b.ts'])
  })

  it('re-queries instead of riding along an in-flight query from another owner target', async () => {
    getWorktreeGitOwnerTargetMock.mockReturnValue({
      kind: 'environment',
      environmentId: 'env-1'
    })
    const { result, rerender } = renderIgnoredPathsHook('wt-runtime-env', ['a.ts'])

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[0]?.[0]?.target).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })

    getWorktreeGitOwnerTargetMock.mockReturnValue({
      kind: 'environment',
      environmentId: 'env-2'
    })
    rerender({ paths: ['a.ts'] })

    // The env-1 query is still in flight, so the env-2 request waits as pending.
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferreds[0]?.resolve(['a.ts'])
    })

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(2)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[1]?.[0]?.target).toEqual({
      kind: 'environment',
      environmentId: 'env-2'
    })
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[1]?.[1]).toEqual(['a.ts'])

    await act(async () => {
      deferreds[1]?.resolve(['a.ts'])
    })

    expect(result.current).toEqual(['a.ts'])
  })

  it('skips querying while the worktree git owner target is unresolved', () => {
    getWorktreeGitOwnerTargetMock.mockReturnValue(null)
    renderIgnoredPathsHook('wt-unresolved-owner', ['a.ts'])

    expect(getRuntimeGitIgnoredPathsMock).not.toHaveBeenCalled()
  })
})
