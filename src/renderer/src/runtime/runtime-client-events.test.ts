import { describe, expect, it, vi } from 'vitest'
import { subscribeRuntimeClientEvents } from './runtime-client-events'

describe('subscribeRuntimeClientEvents', () => {
  it('subscribes to runtime client events and forwards event frames', async () => {
    const unsubscribe = vi.fn()
    let capturedOnResponse: ((response: unknown) => void) | undefined
    const subscribe = vi.fn(async (_args, nextCallbacks) => {
      capturedOnResponse = (nextCallbacks as { onResponse: (response: unknown) => void }).onResponse
      return { unsubscribe, sendBinary: vi.fn() }
    })
    const onEvent = vi.fn()
    const onError = vi.fn()

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { subscribe }
      }
    })

    const subscription = await subscribeRuntimeClientEvents('env-1', onEvent, onError)

    expect(subscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'runtime.clientEvents.subscribe',
        timeoutMs: 15_000
      },
      expect.objectContaining({
        onResponse: expect.any(Function),
        onError
      })
    )

    if (!capturedOnResponse) {
      throw new Error('Expected subscription callbacks')
    }
    capturedOnResponse({
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1' }
    })
    capturedOnResponse({
      ok: true,
      result: { type: 'worktreesChanged', repoId: 'repo-1' }
    })
    capturedOnResponse({
      ok: false,
      error: { code: 'method_not_found', message: 'missing' }
    })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({ type: 'worktreesChanged', repoId: 'repo-1' })
    expect(onError).toHaveBeenCalledWith({ code: 'method_not_found', message: 'missing' })

    subscription.unsubscribe()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('signals a replay-tagged response so event-derived state can resync after a reconnect', async () => {
    let capturedOnResponse: ((response: unknown) => void) | undefined
    const subscribe = vi.fn(async (_args, nextCallbacks) => {
      capturedOnResponse = (nextCallbacks as { onResponse: (response: unknown) => void }).onResponse
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    const onEvent = vi.fn()
    const onReplayed = vi.fn()

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { subscribe }
      }
    })

    await subscribeRuntimeClientEvents('env-1', onEvent, vi.fn(), onReplayed)
    if (!capturedOnResponse) {
      throw new Error('Expected subscription callbacks')
    }

    capturedOnResponse({
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1' }
    })
    expect(onReplayed).not.toHaveBeenCalled()

    capturedOnResponse({
      ok: true,
      result: { type: 'ready', subscriptionId: 'sub-1' },
      _replayedAfterReconnect: true
    })
    expect(onReplayed).toHaveBeenCalledTimes(1)

    // A replay-tagged event frame both signals and still delivers the event.
    capturedOnResponse({
      ok: true,
      result: { type: 'worktreesChanged', repoId: 'repo-1' },
      _replayedAfterReconnect: true
    })
    expect(onReplayed).toHaveBeenCalledTimes(2)
    expect(onEvent).toHaveBeenCalledWith({ type: 'worktreesChanged', repoId: 'repo-1' })
  })

  it('forwards every host terminal sleep disposition through the response decoder', async () => {
    let capturedOnResponse: ((response: unknown) => void) | undefined
    const subscribe = vi.fn(async (_args, nextCallbacks) => {
      capturedOnResponse = (nextCallbacks as { onResponse: (response: unknown) => void }).onResponse
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    const onEvent = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })

    await subscribeRuntimeClientEvents('env-1', onEvent)
    if (!capturedOnResponse) {
      throw new Error('Expected subscription callbacks')
    }
    for (const phase of ['started', 'committed', 'cancelled', 'woken'] as const) {
      capturedOnResponse({
        ok: true,
        result: {
          type: 'worktreeTerminalSleepState',
          worktreeId: 'repo::worktree',
          generation: 17,
          phase,
          ptyIds: ['pty-1'],
          terminalHandles: ['terminal-1']
        }
      })
    }

    expect(onEvent.mock.calls.map(([event]) => event.phase)).toEqual([
      'started',
      'committed',
      'cancelled',
      'woken'
    ])
  })
})
