import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeApp } from './app-driver.mjs'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFileSync: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('update-survival shutdown', () => {
  it('fails before installation instead of killing the daemon tree after a rejected close', async () => {
    const failure = new Error('quit rejected')
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      close: vi.fn().mockRejectedValue(failure)
    }

    await expect(closeApp(app, 45_000, { allowForceKill: false })).rejects.toBe(failure)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('allows normal teardown past ten seconds and still rejects a wedged quit without a tree kill', async () => {
    vi.useFakeTimers()
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      close: vi.fn(() => new Promise(() => {}))
    }
    const closed = closeApp(app, 45_000, { allowForceKill: false })
    const rejected = expect(closed).rejects.toThrow('close timeout')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.getTimerCount()).toBe(1)
    expect(execFileSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(execFileSync).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
