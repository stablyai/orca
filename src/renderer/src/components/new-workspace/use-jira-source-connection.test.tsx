// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import type * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { JiraConnectionStatus } from '../../../../shared/jira/jira-types'
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
