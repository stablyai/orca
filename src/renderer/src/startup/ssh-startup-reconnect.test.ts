import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { reconnectSshTargetForRendererStartup } from './ssh-startup-reconnect'

const connectedState: SshConnectionState = {
  targetId: 'ssh-1',
  status: 'connected',
  error: null,
  reconnectAttempt: 0,
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
