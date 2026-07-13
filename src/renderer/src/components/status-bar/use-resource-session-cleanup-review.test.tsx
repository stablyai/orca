// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ResourceSessionBindingInputs } from './resource-session-bindings'
import type { DaemonSession } from './resource-usage-merge-types'
import {
  useResourceSessionCleanupReview,
  type ResourceSessionCleanupHookDependencies
} from './use-resource-session-cleanup-review'

function session(id: string): DaemonSession {
  return { id, cwd: '/tmp', title: id, agentOwnership: 'absent' }
}

function bindings(): ResourceSessionBindingInputs {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    workspaceSessionReady: true
  }
}

function dependencies(
  overrides: Partial<ResourceSessionCleanupHookDependencies> = {}
): ResourceSessionCleanupHookDependencies {
  return {
    listSessions: vi.fn().mockResolvedValue([session('idle')]),
    readBindings: bindings,
    inspectInactiveCleanup: vi.fn().mockResolvedValue([{ id: 'idle', safety: 'inactive' }]),
    killInactiveSessions: vi.fn().mockResolvedValue([{ id: 'idle', outcome: 'killed' }]),
    ...overrides
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('useResourceSessionCleanupReview', () => {
  it('moves through review, running, and completed states', async () => {
    const cleanup = deferred<{ id: string; outcome: 'killed' }[]>()
    const deps = dependencies({ killInactiveSessions: vi.fn(() => cleanup.promise) })
    const { result } = renderHook(() => useResourceSessionCleanupReview({ dependencies: deps }))

    await act(async () => {
      await result.current.review()
    })
    expect(result.current.state.phase).toBe('ready')

    let completion!: Promise<void>
    act(() => {
      completion = result.current.confirm()
    })
    expect(result.current.state.phase).toBe('running')

    await act(async () => {
      cleanup.resolve([{ id: 'idle', outcome: 'killed' }])
      await completion
    })
    expect(result.current.state).toMatchObject({
      phase: 'completed',
      result: { killedCount: 1, protectedCount: 0, goneCount: 0, failedCount: 0 }
    })
  })

  it('retries a failed review', async () => {
    const listSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([session('idle')])
    const { result } = renderHook(() =>
      useResourceSessionCleanupReview({ dependencies: dependencies({ listSessions }) })
    )

    await act(async () => {
      await result.current.review()
    })
    expect(result.current.state).toMatchObject({
      phase: 'error',
      operation: 'review',
      code: 'review-failed'
    })

    await act(async () => {
      await result.current.retry()
    })
    expect(result.current.state.phase).toBe('ready')
  })

  it('does not reopen after a dismissed review settles', async () => {
    const inspection = deferred<{ id: string; safety: 'inactive' }[]>()
    const { result } = renderHook(() =>
      useResourceSessionCleanupReview({
        dependencies: dependencies({ inspectInactiveCleanup: vi.fn(() => inspection.promise) })
      })
    )

    let completion!: Promise<void>
    act(() => {
      completion = result.current.review()
    })
    expect(result.current.state.phase).toBe('reviewing')
    act(() => {
      result.current.close()
    })
    await act(async () => {
      inspection.resolve([{ id: 'idle', safety: 'inactive' }])
      await completion
    })

    expect(result.current.state.phase).toBe('closed')
  })

  it('locks dismissal while confirmed cleanup is running', async () => {
    const cleanup = deferred<{ id: string; outcome: 'killed' }[]>()
    const { result } = renderHook(() =>
      useResourceSessionCleanupReview({
        dependencies: dependencies({ killInactiveSessions: vi.fn(() => cleanup.promise) })
      })
    )
    await act(async () => {
      await result.current.review()
    })

    let completion!: Promise<void>
    act(() => {
      completion = result.current.confirm()
    })
    act(() => {
      result.current.close()
    })
    expect(result.current.state.phase).toBe('running')

    await act(async () => {
      cleanup.resolve([{ id: 'idle', outcome: 'killed' }])
      await completion
    })
    expect(result.current.state.phase).toBe('completed')
  })

  it('refreshes the visible session inventory after guarded cleanup settles', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([session('idle')])
      .mockResolvedValueOnce([session('idle')])
      .mockResolvedValueOnce([])
    const onSessionsLoaded = vi.fn()
    const { result } = renderHook(() =>
      useResourceSessionCleanupReview({
        dependencies: dependencies({ listSessions }),
        onSessionsLoaded
      })
    )

    await act(async () => {
      await result.current.review()
    })
    await act(async () => {
      await result.current.confirm()
    })

    expect(listSessions).toHaveBeenCalledTimes(3)
    expect(onSessionsLoaded).toHaveBeenLastCalledWith([])
  })

  it('lets confirmed cleanup settle after unmount without renderer callbacks', async () => {
    const refreshedSessions = deferred<DaemonSession[]>()
    const cleanup = deferred<{ id: string; outcome: 'killed' }[]>()
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([session('idle')])
      .mockReturnValueOnce(refreshedSessions.promise)
    const onSessionsLoaded = vi.fn()
    const killInactiveSessions = vi.fn(() => cleanup.promise)
    const { result, unmount } = renderHook(() =>
      useResourceSessionCleanupReview({
        dependencies: dependencies({ listSessions, killInactiveSessions }),
        onSessionsLoaded
      })
    )
    await act(async () => {
      await result.current.review()
    })
    onSessionsLoaded.mockClear()

    let completion!: Promise<void>
    act(() => {
      completion = result.current.confirm()
    })
    unmount()
    refreshedSessions.resolve([session('idle')])
    await Promise.resolve()
    cleanup.resolve([{ id: 'idle', outcome: 'killed' }])
    await completion

    expect(killInactiveSessions).toHaveBeenCalledWith(['idle'])
    expect(onSessionsLoaded).not.toHaveBeenCalled()
  })
})
