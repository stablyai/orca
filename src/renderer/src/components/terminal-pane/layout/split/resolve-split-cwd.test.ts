import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveSplitCwd } from './resolve-split-cwd'

function installGetCwd(fn: (id: string) => Promise<string>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only shim for window.api.pty.getCwd
  ;(globalThis as any).window = {
    api: {
      pty: { getCwd: fn },
      runtimeEnvironments: { call: vi.fn() }
    }
  }
}

describe('resolveSplitCwd', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the IPC value when getCwd resolves just under the timeout', async () => {
    installGetCwd(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('/slow/ipc'), 900)
        })
    )
    const promise = resolveSplitCwd({
      paneCwdMap: new Map(),
      sourcePaneId: 1,
      sourcePtyId: 'pty-1',
      fallbackCwd: '/worktree'
    })
    await vi.advanceTimersByTimeAsync(900)
    expect(await promise).toBe('/slow/ipc')
  })

  it('times out and falls back when IPC hangs', async () => {
    installGetCwd(() => new Promise<string>(() => {}))
    const promise = resolveSplitCwd({
      paneCwdMap: new Map(),
      sourcePaneId: 1,
      sourcePtyId: 'pty-1',
      fallbackCwd: '/worktree'
    })
    await vi.advanceTimersByTimeAsync(1500)
    expect(await promise).toBe('/worktree')
  })
})
