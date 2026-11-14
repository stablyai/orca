// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWindowVisibilityTimeoutPoller } from './window-visibility-timeout-poller'

describe('window visibility timeout poller on window focus', () => {
  const cleanups: (() => void)[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
    vi.useRealTimers()
  })

  function install(args: { refreshOnFocusWhileStopped?: () => boolean }) {
    const run = vi.fn(async () => {})
    const cleanup = installWindowVisibilityTimeoutPoller({
      run,
      getDelayMs: () => null,
      cooldownMs: 10_000,
      ...args
    })
    cleanups.push(cleanup)
    return run
  }

  async function focus(): Promise<void> {
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
  }

  it('ignores focus while no timer is wanted, by default', async () => {
    const run = install({})
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await focus()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs once on focus when a setting, not the data, stopped the timer', async () => {
    const run = install({ refreshOnFocusWhileStopped: () => true })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await focus()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith({ trigger: 'visibility' })
    // Still no timer afterwards.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps the cooldown and in-flight guards for a focus run', async () => {
    let finish!: () => void
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const cleanup = installWindowVisibilityTimeoutPoller({
      run,
      getDelayMs: () => null,
      cooldownMs: 10_000,
      refreshOnFocusWhileStopped: () => true
    })
    cleanups.push(cleanup)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await focus()
    expect(run).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    await focus()
    expect(run).toHaveBeenCalledTimes(2)
    finish()
    await vi.advanceTimersByTimeAsync(1_000)
    await focus()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
