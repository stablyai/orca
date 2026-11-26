import { afterEach, expect, it, vi } from 'vitest'
import { subscribePipelineRunChanges } from './pipeline-run-events'

afterEach(() => vi.unstubAllGlobals())
it('invalidates every observer on loss and ignores obsolete frames after reconnect', async () => {
  const hostWindow = new EventTarget()
  const current = {
    type: 'pipelinesChanged',
    runId: 'current',
    projectId: 'project-current',
    workspaceId: 'workspace-current',
    instanceId: 'instance-current',
    revision: 4,
    sequence: 5
  }
  const frames: ((response: unknown) => void)[] = []
  Object.assign(hostWindow, {
    api: {
      runtime: {
        subscribe: async (_request: unknown, onResponse: (response: unknown) => void) => {
          frames.push(onResponse)
          return { unsubscribe: () => {} }
        }
      }
    }
  })
  vi.stubGlobal('window', hostWindow)
  const first: unknown[] = []
  const second: unknown[] = []
  const firstErrors: unknown[] = []
  const secondErrors: unknown[] = []
  const stopFirst = subscribePipelineRunChanges(
    (value) => first.push(value),
    (error) => firstErrors.push(error)
  )
  const stopSecond = subscribePipelineRunChanges(
    (value) => second.push(value),
    (error) => secondErrors.push(error)
  )
  try {
    await Promise.resolve()
    frames[0]({ ok: false, error: 'connection lost' })
    expect(firstErrors).toEqual(['connection lost'])
    expect(secondErrors).toEqual(['connection lost'])
    hostWindow.dispatchEvent(new Event('online'))
    await Promise.resolve()
    frames[0]({
      ok: true,
      _meta: { runtimeId: 'runtime-1' },
      result: { type: 'pipelinesChanged', runId: 'obsolete' }
    })
    frames.at(-1)!({ ok: true, _meta: { runtimeId: 'runtime-1' }, result: { type: 'ready' } })
    frames.at(-1)!({
      ok: true,
      _meta: { runtimeId: 'runtime-1' },
      result: { type: 'pipelinesChanged', runId: 99 }
    })
    frames.at(-1)!({ ok: true, _meta: { runtimeId: 'runtime-1' }, result: current })
    frames.at(-1)!({
      ok: true,
      _meta: { runtimeId: 'runtime-1' },
      result: {
        type: 'gitStatusChanged',
        repoId: 'project-current',
        worktreeIds: ['workspace-current']
      }
    })
    expect(first).toEqual([
      { type: 'reconnect' },
      current,
      { type: 'gitStatusChanged', repoId: 'project-current', worktreeIds: ['workspace-current'] }
    ])
    expect(second).toEqual(first)
  } finally {
    stopFirst()
    stopSecond()
  }
})
