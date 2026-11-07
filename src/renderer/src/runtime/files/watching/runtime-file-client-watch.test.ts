import { describe, expect, it, vi } from 'vitest'
import { subscribeRuntimeFileChanges } from './runtime-file-watch-client'
import {
  runtimeEnvironmentCall,
  runtimeEnvironmentSubscribe,
  installRuntimeFileClientEnvironment
} from '../runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('delivers remote file changes to listeners for the same worktree', async () => {
    const firstPayload = vi.fn()
    const secondPayload = vi.fn()
    const unsubscribe = vi.fn()
    let onResponse: ((response: unknown) => void) | undefined
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'unwatch',
      ok: true,
      result: { unsubscribed: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
    runtimeEnvironmentSubscribe.mockImplementation((_args, callbacks) => {
      onResponse = callbacks.onResponse
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })

    const firstStop = await subscribeRuntimeFileChanges(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      firstPayload
    )
    const secondStop = await subscribeRuntimeFileChanges(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      secondPayload
    )

    onResponse?.({
      id: 'ready',
      ok: true,
      result: { type: 'ready', subscriptionId: 'files-watch-1' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    onResponse?.({
      id: 'changed',
      ok: true,
      result: {
        type: 'changed',
        worktree: 'id:wt-1',
        events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(firstPayload).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
    })
    expect(secondPayload).toHaveBeenCalledWith({
      worktreePath: '/remote/repo',
      events: [{ kind: 'update', absolutePath: '/remote/repo/readme.md' }]
    })

    firstStop()

    secondStop()
  })
})
