// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import type * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { JiraConnectionStatus } from '../../../../shared/jira-types'
import {
  getJiraSourceConnectionRevisionKey,
  useJiraSourceConnection
} from './use-jira-source-connection'

const mocks = vi.hoisted(() => ({
  readJiraStatus: vi.fn(),
  jiraConnectionRevisions: {} as Record<string, number>,
  listeners: new Set<() => void>()
}))

vi.mock('@/store', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof React>('react')
  const subscribe = (listener: () => void): (() => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  }
  return {
    useAppStore: (
      selector: (value: {
        readJiraStatus: typeof mocks.readJiraStatus
        jiraConnectionRevisions: Record<string, number>
      }) => unknown
    ): unknown =>
      useSyncExternalStore(
        subscribe,
        () =>
          selector({
            readJiraStatus: mocks.readJiraStatus,
            jiraConnectionRevisions: mocks.jiraConnectionRevisions
          }),
        () =>
          selector({
            readJiraStatus: mocks.readJiraStatus,
            jiraConnectionRevisions: mocks.jiraConnectionRevisions
          })
      )
  }
})

function sourceContext(hostId: TaskSourceContext['hostId'] = 'local'): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'jira',
    projectId: 'project-1',
    hostId,
    repoId: 'repo-1',
    providerIdentity: null,
    accountLabel: null
  }
}

function status(connected: boolean): JiraConnectionStatus {
  return { connected, viewer: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('useJiraSourceConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.jiraConnectionRevisions = {}
    mocks.listeners.clear()
  })

  it('exposes Jira only after the selected source host reports a connection', async () => {
    mocks.readJiraStatus.mockResolvedValue(status(true))
    const context = sourceContext()
    const { result } = renderHook(() =>
      useJiraSourceConnection({ enabled: true, sourceContext: context })
    )

    expect(result.current).toEqual({ status: null, loaded: false })
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.status?.connected).toBe(true)
    expect(result.current.loaded).toBe(true)
    expect(mocks.readJiraStatus).toHaveBeenCalledWith(context)
  })

  it('keeps Jira hidden when the selected source host is disconnected', async () => {
    mocks.readJiraStatus.mockResolvedValue(status(false))
    const { result } = renderHook(() =>
      useJiraSourceConnection({ enabled: true, sourceContext: sourceContext('ssh:host-1') })
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.status?.connected).toBe(false)
  })

  it('reads no status until the composer engages Jira', async () => {
    mocks.readJiraStatus.mockResolvedValue(status(true))
    const context = sourceContext()
    const { result, rerender } = renderHook(
      ({ enabled }) => useJiraSourceConnection({ enabled, sourceContext: context }),
      { initialProps: { enabled: false } }
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.readJiraStatus).not.toHaveBeenCalled()
    expect(result.current).toEqual({ status: null, loaded: false })

    rerender({ enabled: true })
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.readJiraStatus).toHaveBeenCalledTimes(1)
    expect(result.current.status?.connected).toBe(true)
  })

  it('keeps a loaded status after engagement drops without re-reading it', async () => {
    mocks.readJiraStatus.mockResolvedValue(status(true))
    const context = sourceContext()
    const { result, rerender } = renderHook(
      ({ enabled }) => useJiraSourceConnection({ enabled, sourceContext: context }),
      { initialProps: { enabled: true } }
    )

    await act(async () => {
      await Promise.resolve()
    })
    const loaded = result.current

    rerender({ enabled: false })
    rerender({ enabled: true })
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.readJiraStatus).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(loaded)
  })

  it('ignores a stale connection result after the source host changes', async () => {
    const local = deferred<JiraConnectionStatus>()
    mocks.readJiraStatus.mockReturnValueOnce(local.promise).mockResolvedValueOnce(status(false))
    const { result, rerender } = renderHook(
      ({ context }) => useJiraSourceConnection({ enabled: true, sourceContext: context }),
      { initialProps: { context: sourceContext() } }
    )

    rerender({ context: sourceContext('runtime:environment-1') })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      local.resolve(status(true))
      await local.promise
    })

    expect(result.current.status?.connected).toBe(false)
  })

  it('re-reads only the matching source after a connection mutation', async () => {
    const context = sourceContext('runtime:environment-1')
    const revisionKey = getJiraSourceConnectionRevisionKey(context)
    mocks.readJiraStatus.mockResolvedValueOnce(status(true)).mockResolvedValueOnce(status(false))
    const { result } = renderHook(() =>
      useJiraSourceConnection({ enabled: true, sourceContext: context })
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.status?.connected).toBe(true)

    await act(async () => {
      mocks.jiraConnectionRevisions = { 'runtime:other#0': 1 }
      for (const listener of mocks.listeners) {
        listener()
      }
      await Promise.resolve()
    })
    expect(mocks.readJiraStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      mocks.jiraConnectionRevisions = {
        ...mocks.jiraConnectionRevisions,
        [revisionKey!]: 1
      }
      for (const listener of mocks.listeners) {
        listener()
      }
      await Promise.resolve()
    })
    expect(mocks.readJiraStatus).toHaveBeenCalledTimes(2)
    expect(result.current.status?.connected).toBe(false)
  })
})
