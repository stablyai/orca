import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  openStreamAndConfirmReady,
  rpcError,
  settle
} from './remote-browser-stream-lifecycle-test-harness'

const SERVICE_NOTICE = 'The remote browser is unavailable. Check its setup on the server.'

describe('browser service failures on a responding remote host', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps browser service recovery bounded and restores the stream once it returns', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('browser_unavailable', 'backend exited'))
    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.currentError).toBe(SERVICE_NOTICE)
    expect(harness.reconnectOffered).toBe(false)
    harness.failEverySubscribe(null)
    await vi.advanceTimersByTimeAsync(1_000)
    harness.streams.at(-1)?.emitReady()
    await settle()
    expect(harness.currentStatusKind).toBe('live')
    expect(harness.currentError).toBeNull()
  })

  it('offers manual recovery with the service notice after retry exhaustion', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    harness.failEverySubscribe(rpcError('browser_unavailable', 'backend remains unavailable'))
    harness.streams[0].emitEnd()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.currentError).toBe(SERVICE_NOTICE)
    expect(harness.reconnectOffered).toBe(true)
    expect(harness.subscribeAttempts).toBeLessThanOrEqual(6)
  })
})
