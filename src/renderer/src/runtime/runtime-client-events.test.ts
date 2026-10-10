import { describe, expect, it, vi } from 'vitest'
import type { SshProviderEpoch } from '../../../shared/ssh-types'
import { subscribeRuntimeClientEvents } from './runtime-client-events'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

describe('subscribeRuntimeClientEvents', () => {
  it('subscribes to runtime client events and forwards event frames', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
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
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: 7
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
      ok: true,
      result: {
        type: 'terminalSideEffects',
        batch: { ptyId: 'pty-1', seq: 7, facts: [{ kind: 'bell' }] }
      }
    })
    capturedOnResponse({
      ok: true,
      result: {
        type: 'nativeChatLaunchDraftResolved',
        tabId: 'tab-1',
        text: 'seed',
        createdAt: 7
      }
    })
    capturedOnResponse({
      ok: false,
      error: { code: 'method_not_found', message: 'missing' }
    })

    expect(onEvent).toHaveBeenCalledTimes(3)
    expect(onEvent).toHaveBeenCalledWith({ type: 'worktreesChanged', repoId: 'repo-1' })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'terminalSideEffects',
      batch: { ptyId: 'pty-1', seq: 7, facts: [{ kind: 'bell' }] }
    })
    expect(onEvent).toHaveBeenCalledWith({
      type: 'nativeChatLaunchDraftResolved',
      tabId: 'tab-1',
      text: 'seed',
      createdAt: 7
    })
    expect(onError).toHaveBeenCalledWith({ code: 'method_not_found', message: 'missing' })

    subscription.unsubscribe()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('forwards automationsChanged and still drops event types it does not know', async () => {
    let capturedOnResponse: ((response: unknown) => void) | undefined
    const subscribe = vi.fn(async (_args, nextCallbacks) => {
      capturedOnResponse = (nextCallbacks as { onResponse: (response: unknown) => void }).onResponse
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    const onEvent = vi.fn()
    const onError = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })

    await subscribeRuntimeClientEvents('env-1', onEvent, onError)
    if (!capturedOnResponse) {
      throw new Error('Expected subscription callbacks')
    }

    capturedOnResponse({ ok: true, result: { type: 'automationsChanged', reason: 'run' } })
    // Why: the same allowlist is what makes this event additive for old clients.
    capturedOnResponse({ ok: true, result: { type: 'automationsFromTheFuture' } })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({ type: 'automationsChanged', reason: 'run' })
    expect(onError).not.toHaveBeenCalled()
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

  it('preserves full SSH authority in retained snapshots and live client events', async () => {
    let capturedOnResponse: ((response: unknown) => void) | undefined
    const subscribe = vi.fn(async (_args, nextCallbacks) => {
      capturedOnResponse = (nextCallbacks as { onResponse: (response: unknown) => void }).onResponse
      return { subscriptionId: 'sub-1', unsubscribe: vi.fn() }
    })
    const onEvent = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
    await subscribeRuntimeClientEvents('env-1', onEvent)
    if (!capturedOnResponse) {
      throw new Error('Expected subscription callbacks')
    }
    capturedOnResponse({
      ok: true,
      result: {
        type: 'ready',
        subscriptionId: 'sub-1',
        snapshot: {
          sshStates: [
            {
              targetId: 'ssh-1',
              state: {
                targetId: 'ssh-1',
                status: 'connected',
                error: null,
                reconnectAttempt: 0,
                providerEpoch: 'snapshot-provider-epoch' as SshProviderEpoch,
                connectionGeneration: 17
              }
            }
          ]
        }
      }
    })

    expect(onEvent).toHaveBeenCalledWith({
      type: 'sshStateChanged',
      targetId: 'ssh-1',
      state: {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'snapshot-provider-epoch',
        connectionGeneration: 17
      }
    })

    capturedOnResponse({
      ok: true,
      result: {
        type: 'sshStateChanged',
        targetId: 'ssh-1',
        state: {
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          providerEpoch: 'live-provider-epoch' as SshProviderEpoch,
          connectionGeneration: 18
        }
      }
    })

    expect(onEvent).toHaveBeenLastCalledWith({
      type: 'sshStateChanged',
      targetId: 'ssh-1',
      state: {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'live-provider-epoch',
        connectionGeneration: 18
      }
    })
  })

  it('rejects a partial runtime authority instead of retaining it', async () => {
    let capturedOnResponse: ((response: unknown) => void) | undefined
    const subscribe = vi.fn(async (_args, nextCallbacks) => {
      capturedOnResponse = (nextCallbacks as { onResponse: (response: unknown) => void }).onResponse
      return { subscriptionId: 'sub-1', unsubscribe: vi.fn() }
    })
    const onEvent = vi.fn()
    const onError = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
    await subscribeRuntimeClientEvents('env-1', onEvent, onError)
    if (!capturedOnResponse) {
      throw new Error('Expected subscription callbacks')
    }

    capturedOnResponse({
      ok: true,
      result: {
        type: 'sshStateChanged',
        targetId: 'ssh-1',
        state: {
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          providerEpoch: 'partial-provider-epoch'
        }
      }
    })

    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }))
  })
})
