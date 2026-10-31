import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTerminalProviderSnapshotCapabilities,
  collectTerminalProviderSnapshotPtyIds,
  refreshTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderHasAuthoritativeSnapshot
} from './terminal-provider-snapshot-capability'

describe('terminal provider snapshot capabilities', () => {
  beforeEach(() => clearTerminalProviderSnapshotCapabilities())
  afterEach(() => vi.useRealTimers())

  it('collects every restored split-pane binding once', () => {
    expect(
      collectTerminalProviderSnapshotPtyIds({
        tabsByWorktree: {
          worktree: [
            { id: 'tab-1', ptyId: 'primary' },
            { id: 'tab-2', ptyId: null }
          ]
        },
        ptyIdsByTabId: {
          'tab-1': ['primary', 'split'],
          'tab-2': ['folder-pane']
        },
        pendingReconnectPtyIdByTabId: { 'tab-2': 'restored-primary' },
        terminalLayoutsByTabId: {
          'tab-2': { ptyIdsByLeafId: { leaf: 'restored-split' } }
        }
      })
    ).toEqual(['primary', 'split', 'folder-pane', 'restored-primary', 'restored-split'])
  })

  it('records current and legacy daemon capabilities from one batch', async () => {
    const resolve = vi.fn(async () => [
      { id: 'current', authoritative: true },
      { id: 'legacy', authoritative: false }
    ])

    await synchronizeTerminalProviderSnapshotCapabilities(['current', 'legacy'], resolve)

    expect(resolve).toHaveBeenCalledWith(['current', 'legacy'])
    expect(terminalProviderHasAuthoritativeSnapshot('current')).toBe(true)
    expect(terminalProviderHasAuthoritativeSnapshot('legacy')).toBe(false)
  })

  it('refreshes a pre-provider false after startup services become ready', async () => {
    await synchronizeTerminalProviderSnapshotCapabilities(['restored-pty'], async () => [
      { id: 'restored-pty', authoritative: false }
    ])
    const readyResolve = vi.fn(async () => [{ id: 'restored-pty', authoritative: true }])

    await refreshTerminalProviderSnapshotCapabilities(['restored-pty'], readyResolve)

    expect(readyResolve).toHaveBeenCalledWith(['restored-pty'])
    expect(terminalProviderHasAuthoritativeSnapshot('restored-pty')).toBe(true)
  })

  it('caches resolved PTYs and prunes closed ones', async () => {
    const resolve = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true as boolean | null }))
    )

    await synchronizeTerminalProviderSnapshotCapabilities(['pty-1', 'pty-2'], resolve)
    await synchronizeTerminalProviderSnapshotCapabilities(['pty-2', 'pty-3'], resolve)

    expect(resolve).toHaveBeenNthCalledWith(1, ['pty-1', 'pty-2'])
    expect(resolve).toHaveBeenNthCalledWith(2, ['pty-3'])
    expect(terminalProviderHasAuthoritativeSnapshot('pty-1')).toBe(false)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-2')).toBe(true)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-3')).toBe(true)
  })

  it('does not rescan an unchanged fully resolved PTY collection on later renders', async () => {
    let indexedReads = 0
    const ids = new Proxy(['pty-1', 'pty-2'], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          indexedReads += 1
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
        return Reflect.get(target, property, receiver)
      }
    })
    const resolve = vi.fn(async (batch: string[]) =>
      batch.map((id) => ({ id, authoritative: true as boolean | null }))
    )

    await synchronizeTerminalProviderSnapshotCapabilities(ids, resolve)
    indexedReads = 0
    await synchronizeTerminalProviderSnapshotCapabilities(ids, resolve)

    expect(indexedReads).toBe(0)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('bounds initial capability IPC to batches of 512 PTYs', async () => {
    const ids = Array.from({ length: 1_025 }, (_, index) => `pty-${index}`)
    const resolve = vi.fn(async (batch: string[]) =>
      batch.map((id) => ({ id, authoritative: true as boolean | null }))
    )

    await synchronizeTerminalProviderSnapshotCapabilities(ids, resolve)

    expect(resolve.mock.calls.map(([batch]) => batch.length)).toEqual([512, 512, 1])
  })

  it('retries capabilities that are still unknown during daemon startup', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'pty-1', authoritative: null }])
      .mockResolvedValueOnce([{ id: 'pty-1', authoritative: true }])

    await synchronizeTerminalProviderSnapshotCapabilities(['pty-1'], resolve, 1_000)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-1')).toBe(false)
    await synchronizeTerminalProviderSnapshotCapabilities(['pty-1'], resolve, 1_999)
    expect(resolve).toHaveBeenCalledOnce()
    await synchronizeTerminalProviderSnapshotCapabilities(['pty-1'], resolve, 2_000)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-1')).toBe(true)
  })

  it('bounds an unresponsive capability resolver and keeps the result unknown', async () => {
    vi.useFakeTimers()
    const synchronization = synchronizeTerminalProviderSnapshotCapabilities(
      ['pty-1'],
      () => new Promise(() => {}),
      1_000
    )

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(synchronization).resolves.toBe(1_000)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-1')).toBe(false)
  })

  it('retries immediately when a timeout consumes the retry delay', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const synchronization = synchronizeTerminalProviderSnapshotCapabilities(
      ['pty-1'],
      () => new Promise(() => {})
    )

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(synchronization).resolves.toBe(0)
  })

  it('ignores a stale capability response after the live PTY set changes', async () => {
    let resolveStale!: (value: { id: string; authoritative: boolean | null }[]) => void
    const stale = new Promise<{ id: string; authoritative: boolean | null }[]>((resolve) => {
      resolveStale = resolve
    })
    const first = synchronizeTerminalProviderSnapshotCapabilities(['old-pty'], () => stale)
    await synchronizeTerminalProviderSnapshotCapabilities(['current-pty'], async () => [
      { id: 'current-pty', authoritative: true }
    ])

    resolveStale([{ id: 'old-pty', authoritative: true }])
    await first

    expect(terminalProviderHasAuthoritativeSnapshot('old-pty')).toBe(false)
    expect(terminalProviderHasAuthoritativeSnapshot('current-pty')).toBe(true)
  })

  // Superseded startup refreshes need a zero-delay retry; null would kill the only surviving timer chain.
  it('asks a superseded pass to re-check instead of ending its timer chain', async () => {
    let resolveStale!: (value: { id: string; authoritative: boolean | null }[]) => void
    const stale = new Promise<{ id: string; authoritative: boolean | null }[]>((resolve) => {
      resolveStale = resolve
    })
    const first = synchronizeTerminalProviderSnapshotCapabilities(['pty-1'], () => stale, 1_000)
    await synchronizeTerminalProviderSnapshotCapabilities(['pty-1', 'pty-2'], async () => [], 1_000)

    resolveStale([{ id: 'pty-1', authoritative: true }])

    await expect(first).resolves.toBe(0)
  })

  it('asks a superseded pass whose resolver rejected to re-check as well', async () => {
    let rejectStale!: (reason: Error) => void
    const stale = new Promise<{ id: string; authoritative: boolean | null }[]>((_, reject) => {
      rejectStale = reject
    })
    const first = synchronizeTerminalProviderSnapshotCapabilities(['pty-1'], () => stale, 1_000)
    await synchronizeTerminalProviderSnapshotCapabilities(['pty-1', 'pty-2'], async () => [], 1_000)

    rejectStale(new Error('daemon unavailable'))

    await expect(first).resolves.toBe(0)
  })

  it('decays polling to a slow cadence for a PTY whose route never resolves', async () => {
    // Unknown routes stay exempt but re-askable instead of inheriting permanent eviction exemption.
    const resolve = vi.fn(async () => [{ id: 'gone-pty', authoritative: null }])
    const backoffSchedule = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]

    let nowMs = 1_000
    await synchronizeTerminalProviderSnapshotCapabilities(['gone-pty'], resolve, nowMs)
    for (const delayMs of backoffSchedule) {
      await synchronizeTerminalProviderSnapshotCapabilities(
        ['gone-pty'],
        resolve,
        nowMs + delayMs - 1
      )
      nowMs += delayMs
      await synchronizeTerminalProviderSnapshotCapabilities(['gone-pty'], resolve, nowMs)
    }
    const ladderCallCount = resolve.mock.calls.length
    expect(ladderCallCount).toBe(backoffSchedule.length + 1)

    await synchronizeTerminalProviderSnapshotCapabilities(['gone-pty'], resolve, nowMs + 60_000)
    expect(resolve).toHaveBeenCalledTimes(ladderCallCount)

    for (let index = 1; index <= 12; index += 1) {
      await synchronizeTerminalProviderSnapshotCapabilities(
        ['gone-pty'],
        resolve,
        nowMs + index * 5 * 60_000
      )
    }
    expect(resolve.mock.calls.length).toBe(ladderCallCount + 12)
    expect(terminalProviderHasAuthoritativeSnapshot('gone-pty')).toBe(false)
  })

  it('keeps rescheduling at the slow cadence once an unresolvable PTY has decayed', async () => {
    const resolve = vi.fn(async () => [{ id: 'gone-pty', authoritative: null }])

    let nowMs = 1_000
    let retryDelayMs: number | null = null
    for (const delayMs of [0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      nowMs += delayMs
      retryDelayMs = await synchronizeTerminalProviderSnapshotCapabilities(
        ['gone-pty'],
        resolve,
        nowMs
      )
    }

    // Keep one slow timer so daemon recovery requires no external event.
    expect(retryDelayMs).toBe(5 * 60_000)
  })

  // Due retries must bypass same-array identity early-outs or the hook’s unchanged-ID chain dies.
  it('re-consults a due unknown on an identical live-set identity', async () => {
    const livePtyIds = ['pty-1']
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'pty-1', authoritative: null }])
      .mockResolvedValueOnce([{ id: 'pty-1', authoritative: true }])

    await synchronizeTerminalProviderSnapshotCapabilities(livePtyIds, resolve, 1_000)
    const retryDelayMs = await synchronizeTerminalProviderSnapshotCapabilities(
      livePtyIds,
      resolve,
      2_000
    )

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(retryDelayMs).toBeNull()
    expect(terminalProviderHasAuthoritativeSnapshot('pty-1')).toBe(true)
  })

  it('re-probes an unknown PTY from scratch after it closes and a new one appears', async () => {
    const resolve = vi.fn(async () => [{ id: 'gone-pty', authoritative: null }])

    await synchronizeTerminalProviderSnapshotCapabilities(['gone-pty'], resolve, 1_000)
    // Pruning closed PTYs must stop their retry timer chain too.
    await expect(
      synchronizeTerminalProviderSnapshotCapabilities([], resolve, 2_000)
    ).resolves.toBeNull()
    await synchronizeTerminalProviderSnapshotCapabilities(['gone-pty'], resolve, 2_001)
    expect(resolve).toHaveBeenCalledTimes(2)

    // Reappearing IDs restart the fast ladder instead of inheriting leaked slow backoff.
    await synchronizeTerminalProviderSnapshotCapabilities(['gone-pty'], resolve, 3_001)
    expect(resolve).toHaveBeenCalledTimes(3)
  })
})
