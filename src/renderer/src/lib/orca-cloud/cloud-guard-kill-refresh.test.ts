import { describe, expect, it, vi } from 'vitest'
import { ACTIVITY_REFRESH_MS, installCloudActivityRefresh } from './cloud-guard-kill-refresh'

describe('installCloudActivityRefresh', () => {
  it('re-reads the active running cloud workspace on focus or typing, throttled', () => {
    const target = new EventTarget()
    let now = 0
    let running = true
    const refresh = vi.fn()
    const dispose = installCloudActivityRefresh({
      activeWorkspaceId: () => 'ws',
      isRunningCloud: () => running,
      refresh,
      target,
      now: () => now
    })
    target.dispatchEvent(new Event('focus'))
    target.dispatchEvent(new Event('keydown'))
    expect(refresh).toHaveBeenCalledTimes(1)
    now = ACTIVITY_REFRESH_MS
    target.dispatchEvent(new Event('keydown'))
    expect(refresh).toHaveBeenCalledTimes(2)
    now = 3 * ACTIVITY_REFRESH_MS
    running = false
    target.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(2)
    dispose()
    running = true
    target.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
