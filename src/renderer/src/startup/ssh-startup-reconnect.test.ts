import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshProviderEpoch } from '../../../shared/ssh-types'
import { reconnectSshTargetForRendererStartup } from './ssh-startup-reconnect'

const connectedState: SshConnectionState = {
  targetId: 'ssh-1',
  status: 'connected',
  error: null,
  reconnectAttempt: 0,
  providerEpoch: 'startup-provider-epoch' as SshProviderEpoch,
  connectionGeneration: 41,
  remotePlatform: 'linux'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('reconnectSshTargetForRendererStartup', () => {
  it('publishes the connect result before startup terminal restoration continues', async () => {
    const publishState = vi.fn()
    const result = await reconnectSshTargetForRendererStartup({
      targetId: 'ssh-1',
      timeoutMs: 1_000,
      connect: vi.fn().mockResolvedValue(connectedState),
      publishState,
      onFailure: vi.fn()
    })

    expect(result).toEqual({ timedOut: false })
    expect(publishState).toHaveBeenCalledWith('ssh-1', connectedState)
    expect(publishState.mock.calls[0]?.[1]).toMatchObject({
      providerEpoch: 'startup-provider-epoch',
      connectionGeneration: 41
    })
  })

  it('does not synthesize the missing half of a partial startup authority', async () => {
    const publishState = vi.fn()
    const partialState = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      providerEpoch: 'partial-provider-epoch' as SshProviderEpoch
    } satisfies SshConnectionState

    await reconnectSshTargetForRendererStartup({
      targetId: 'ssh-1',
      timeoutMs: 1_000,
      connect: vi.fn().mockResolvedValue(partialState),
      publishState,
      onFailure: vi.fn()
    })

    expect(publishState).toHaveBeenCalledWith('ssh-1', partialState)
    expect(publishState.mock.calls[0]?.[1]).not.toHaveProperty('connectionGeneration')
  })

  it('marks a stalled connect as deferred without publishing stale state', async () => {
    vi.useFakeTimers()
    const publishState = vi.fn()
    const onFailure = vi.fn()
    const resultPromise = reconnectSshTargetForRendererStartup({
      targetId: 'ssh-1',
      timeoutMs: 1_000,
      connect: () => new Promise(() => {}),
      publishState,
      onFailure
    })

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(resultPromise).resolves.toEqual({ timedOut: true })
    expect(publishState).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith('ssh-1', expect.any(Error))
  })
})
