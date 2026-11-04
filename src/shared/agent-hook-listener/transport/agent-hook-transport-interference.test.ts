import { describe, expect, it, vi } from 'vitest'
import {
  createHookTransportInterferenceTracker,
  HookRequestTruncatedError
} from './agent-hook-transport-interference'

describe('createHookTransportInterferenceTracker', () => {
  const truncation = { source: 'claude', error: new HookRequestTruncatedError(10, 900) }

  it('reports exactly once at the threshold and keeps counting after', () => {
    const onThreshold = vi.fn()
    const tracker = createHookTransportInterferenceTracker(onThreshold, 3)
    for (let i = 0; i < 6; i++) {
      tracker.record(truncation)
    }
    expect(onThreshold).toHaveBeenCalledTimes(1)
    expect(onThreshold).toHaveBeenCalledWith({
      count: 3,
      source: 'claude',
      bytesRead: 10,
      contentLength: 900
    })
    expect(tracker.getCount()).toBe(6)
  })

  it('re-arms after reset', () => {
    const onThreshold = vi.fn()
    const tracker = createHookTransportInterferenceTracker(onThreshold, 1)
    tracker.record(truncation)
    tracker.reset()
    tracker.record(truncation)
    expect(onThreshold).toHaveBeenCalledTimes(2)
  })
})
