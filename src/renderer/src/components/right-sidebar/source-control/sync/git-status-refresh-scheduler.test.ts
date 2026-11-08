import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitStatusRefreshScheduler } from './git-status-refresh-scheduler'

describe('createGitStatusRefreshScheduler cadence scale', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defers unfocused change signals and runs them once refocus makes them due', async () => {
    vi.useFakeTimers()
    let unfocused = false
    const reasons: string[] = []
    const scheduler = createGitStatusRefreshScheduler(
      async ({ reason }) => {
        reasons.push(reason)
      },
      {
        safetyIntervalMs: 60_000,
        activityDebounceMs: 100,
        activityMinGapMs: 3000,
        slowTaskBackoff: { idleMultiplier: 1, changeSignalMultiplier: 1, maxIntervalMs: 300_000 },
        cadenceScale: () => (unfocused ? 4 : 1)
      }
    )
    scheduler.refreshNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(reasons).toEqual(['activity'])

    unfocused = true
    scheduler.signal()
    await vi.advanceTimersByTimeAsync(5000)
    expect(reasons).toEqual(['activity'])

    unfocused = false
    scheduler.retime()
    await vi.advanceTimersByTimeAsync(0)
    expect(reasons).toEqual(['activity', 'activity'])
    scheduler.dispose()
  })
})
