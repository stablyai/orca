// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localTasksListForTarget } from './runtime-local-tasks-client'

const callRuntimeRpc = vi.fn()
vi.mock('../rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

const result = { folder: '/f', tasks: [] }

afterEach(() => {
  callRuntimeRpc.mockReset()
  vi.unstubAllGlobals()
})

describe('localTasksListForTarget', () => {
  it('calls localTasks.list on the remote environment', async () => {
    callRuntimeRpc.mockResolvedValue(result)
    const list = vi.fn()
    vi.stubGlobal('window', { api: { localTasks: { list } } })
    const target = { kind: 'environment' as const, environmentId: 'remote' }
    await expect(localTasksListForTarget(target)).resolves.toBe(result)
    expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'localTasks.list', undefined, {
      timeoutMs: 15_000
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('uses IPC for the local desktop host', async () => {
    const list = vi.fn().mockResolvedValue(result)
    vi.stubGlobal('window', { api: { localTasks: { list } } })
    await expect(localTasksListForTarget({ kind: 'local' })).resolves.toBe(result)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
