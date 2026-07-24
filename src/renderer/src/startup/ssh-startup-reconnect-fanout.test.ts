import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { reconnectSshTargetsForRendererStartup } from './ssh-startup-reconnect'

function connectedState(targetId: string): SshConnectionState {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    remotePlatform: 'linux'
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SSH startup reconnect fanout', () => {
  it('bounds a large target list and publishes every successful result', async () => {
    const targetIds = Array.from({ length: 100 }, (_, index) => `ssh-${index}`)
    let inFlight = 0
    let peak = 0
    const connect = vi.fn(async (targetId: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return connectedState(targetId)
    })
    const publishState = vi.fn()

    const timedOut = await reconnectSshTargetsForRendererStartup({
      targetIds,
      timeoutMs: 1_000,
      connect,
      publishState,
      onFailure: vi.fn()
    })

    expect(peak).toBe(4)
    expect(timedOut).toEqual([])
    expect(connect).toHaveBeenCalledTimes(targetIds.length)
    expect(publishState).toHaveBeenCalledTimes(targetIds.length)
  })

  it('defers queued targets without extending the shared startup deadline', async () => {
    vi.useFakeTimers()
    const targetIds = Array.from({ length: 10 }, (_, index) => `ssh-${index}`)
    const connect = vi.fn(() => new Promise<SshConnectionState | null>(() => {}))
    const result = reconnectSshTargetsForRendererStartup({
      targetIds,
      timeoutMs: 1_000,
      connect,
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(result).resolves.toEqual(targetIds)
    expect(connect).toHaveBeenCalledTimes(4)
  })
})
