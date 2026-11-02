import { describe, expect, it } from 'vitest'
import {
  REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS,
  createRemoteRuntimeDisconnectedInputGrace
} from './remote-runtime-disconnected-input-grace'

describe('disconnected input grace', () => {
  it('expires once the latch outlives its grace', () => {
    let now = 0
    const grace = createRemoteRuntimeDisconnectedInputGrace(() => now)
    grace.start()
    now = REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS - 1
    expect(grace.isExpired()).toBe(false)
    now += 1
    expect(grace.isExpired()).toBe(true)
  })

  it('carries a retry begun inside the grace, then measures the next latch from the first', () => {
    let now = 0
    const grace = createRemoteRuntimeDisconnectedInputGrace(() => now)
    grace.start()
    now = REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS - 10_000
    grace.carryThroughRetry()
    now = REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS + 60_000
    expect(grace.isExpired()).toBe(false)
    // The retry gave up again: a fresh latch must not restart the clock.
    grace.start()
    expect(grace.isExpired()).toBe(true)
  })

  it('has nothing to carry before any latch, and forgets everything on reset', () => {
    let now = 0
    const grace = createRemoteRuntimeDisconnectedInputGrace(() => now)
    grace.carryThroughRetry()
    grace.start()
    now = REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS
    expect(grace.isExpired()).toBe(true)
    grace.reset()
    expect(grace.isExpired()).toBe(false)
  })
})
