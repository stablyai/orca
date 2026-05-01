import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'

function installGetCwd(fn: (id: string) => Promise<string>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only shim for window.api.pty.getCwd
  ;(globalThis as any).window = { api: { pty: { getCwd: fn } } }
}

describe('resolveSplitCwd', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the confirmed OSC 7 entry without calling IPC', async () => {
    const getCwd = vi.fn()
    installGetCwd(getCwd as unknown as (id: string) => Promise<string>)
    const paneCwdMap: PaneCwdMap = new Map([[1, { cwd: '/live/here', confirmed: true }]])
    const result = await resolveSplitCwd({
      paneCwdMap,
      sourcePaneId: 1,
      sourcePtyId: 'pty-1',
      fallbackCwd: '/worktree'
    })
    expect(result).toBe('/live/here')
    expect(getCwd).not.toHaveBeenCalled()
  })

  it('queries IPC when no confirmed entry exists', async () => {
    installGetCwd(async () => '/tmp/ipc')
    const paneCwdMap: PaneCwdMap = new Map()
    const result = await resolveSplitCwd({
      paneCwdMap,
      sourcePaneId: 1,
      sourcePtyId: 'pty-1',
      fallbackCwd: '/worktree'
    })
    expect(result).toBe('/tmp/ipc')
  })

  it('falls through to the unconfirmed cached entry when IPC returns empty', async () => {
    installGetCwd(async () => '')
    const paneCwdMap: PaneCwdMap = new Map([[1, { cwd: '/replayed', confirmed: false }]])
    const result = await resolveSplitCwd({
      paneCwdMap,
      sourcePaneId: 1,
      sourcePtyId: 'pty-1',
      fallbackCwd: '/worktree'
    })
    expect(result).toBe('/replayed')
  })

  it('falls back to worktree root when OSC 7 and IPC both miss', async () => {
    installGetCwd(async () => '')
    const result = await resolveSplitCwd({
      paneCwdMap: new Map(),
      sourcePaneId: 1,
      sourcePtyId: 'pty-1',
      fallbackCwd: '/worktree'
    })
    expect(result).toBe('/worktree')
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

  it('skips IPC entirely when there is no source PTY id', async () => {
    const getCwd = vi.fn()
    installGetCwd(getCwd as unknown as (id: string) => Promise<string>)
    const result = await resolveSplitCwd({
      paneCwdMap: new Map(),
      sourcePaneId: 1,
      sourcePtyId: null,
      fallbackCwd: '/worktree'
    })
    expect(result).toBe('/worktree')
    expect(getCwd).not.toHaveBeenCalled()
  })
})
