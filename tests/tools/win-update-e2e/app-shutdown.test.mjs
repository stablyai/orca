import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeApp } from './app-driver.mjs'

const processes = {
  isPidAlive: vi.fn().mockReturnValue(true),
  killTree: vi.fn()
}
const strictCloseOptions = { allowForceKill: false, processes }

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  processes.isPidAlive.mockReturnValue(true)
})

describe('update-survival shutdown', () => {
  it('keeps the force-kill fallback enabled for best-effort cleanup', async () => {
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, stdio: [] }),
      close: vi.fn().mockRejectedValue(new Error('quit rejected'))
    }

    await closeApp(app, 45_000, { processes })

    expect(processes.killTree).toHaveBeenCalledExactlyOnceWith(123)
  })

  it('fails before installation instead of killing the daemon tree after a rejected close', async () => {
    const failure = new Error('quit rejected')
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, stdio: [] }),
      close: vi.fn().mockRejectedValue(failure)
    }

    await expect(closeApp(app, 45_000, strictCloseOptions)).rejects.toBe(failure)
    expect(processes.killTree).not.toHaveBeenCalled()
  })

  it('allows normal teardown past ten seconds and still rejects a wedged quit without a tree kill', async () => {
    vi.useFakeTimers()
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, stdio: [] }),
      close: vi.fn(() => new Promise(() => {}))
    }
    const closed = closeApp(app, 45_000, strictCloseOptions)
    const rejected = expect(closed).rejects.toThrow('close timeout')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.getTimerCount()).toBe(1)
    expect(processes.killTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(processes.killTree).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a resolved close while the authoritative main remains live', async () => {
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, stdio: [] }),
      close: vi.fn().mockResolvedValue(undefined)
    }

    await expect(closeApp(app, 45_000, strictCloseOptions)).rejects.toThrow(
      'authoritative Electron PID remains live'
    )
    expect(processes.isPidAlive).toHaveBeenCalledWith(123)
    expect(processes.killTree).not.toHaveBeenCalled()
  })

  it('accepts verified main and launcher exit while inherited pipes keep close pending', async () => {
    vi.useFakeTimers()
    processes.isPidAlive.mockReturnValue(false)
    const app = {
      evaluate: vi.fn().mockResolvedValue(123),
      process: () => ({ pid: 124, exitCode: 0, stdio: [{ readableEnded: false }] }),
      close: vi.fn(() => new Promise(() => {}))
    }
    const closed = expect(closeApp(app, 45_000, strictCloseOptions)).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(45_000)
    await closed
    expect(processes.isPidAlive).toHaveBeenCalledWith(123)
    expect(processes.isPidAlive).toHaveBeenCalledWith(124)
    expect(processes.killTree).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['live', 'unverifiable'])(
    'rejects a %s launcher even when the main exited',
    async (state) => {
      vi.useFakeTimers()
      processes.isPidAlive.mockImplementation((pid) => {
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
      const closed = expect(closeApp(app, 45_000, strictCloseOptions)).rejects.toThrow(
        'close timeout'
      )

      await vi.advanceTimersByTimeAsync(45_000)
      await closed
      expect(processes.killTree).not.toHaveBeenCalled()
    }
  )
})
