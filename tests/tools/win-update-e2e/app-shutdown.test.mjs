import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeApp } from './app-driver.mjs'
import { isPidAlive } from './daemon-processes.mjs'

vi.mock('./daemon-processes.mjs', () => ({ isPidAlive: vi.fn().mockReturnValue(true) }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFileSync: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.mocked(isPidAlive).mockReturnValue(true)
})

describe('update-survival shutdown', () => {
  it('fails before installation instead of killing the daemon tree after a rejected close', async () => {
    const failure = new Error('quit rejected')
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, stdio: [] }),
      close: vi.fn().mockRejectedValue(failure)
    }

    await expect(closeApp(app, 45_000, { allowForceKill: false })).rejects.toBe(failure)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('allows normal teardown past ten seconds and still rejects a wedged quit without a tree kill', async () => {
    vi.useFakeTimers()
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, stdio: [] }),
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

  it('rejects a resolved close while the authoritative main remains live', async () => {
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, stdio: [] }),
      close: vi.fn().mockResolvedValue(undefined)
    }

    await expect(closeApp(app, 45_000, { allowForceKill: false })).rejects.toThrow(
      'authoritative Electron PID remains live'
    )
    expect(isPidAlive).toHaveBeenCalledWith(123)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('accepts verified main and launcher exit while inherited pipes keep close pending', async () => {
    vi.useFakeTimers()
    vi.mocked(isPidAlive).mockReturnValue(false)
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, exitCode: 0, stdio: [{ readableEnded: false }] }),
      close: vi.fn(() => new Promise(() => {}))
    }
    const closed = expect(closeApp(app, 45_000, { allowForceKill: false })).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(45_000)
    await closed
    expect(isPidAlive).toHaveBeenCalledWith(123)
    expect(isPidAlive).toHaveBeenCalledWith(124)
    expect(execFileSync).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['live', 'unverifiable'])(
    'rejects a %s launcher even when the main exited',
    async (state) => {
      vi.useFakeTimers()
      vi.mocked(isPidAlive).mockImplementation((pid) => {
        if (pid === 123) {
          return false
        }
        if (state === 'unverifiable') {
          throw new Error('process query failed')
        }
        return true
      })
      const app = {
        evaluate: vi.fn().mockResolvedValue(123),
        process: () => ({ pid: 124, stdio: [] }),
        close: vi.fn(() => new Promise(() => {}))
      }
      const closed = expect(closeApp(app, 45_000, { allowForceKill: false })).rejects.toThrow(
        'close timeout'
      )

      await vi.advanceTimersByTimeAsync(45_000)
      await closed
      expect(execFileSync).not.toHaveBeenCalled()
    }
  )
})
