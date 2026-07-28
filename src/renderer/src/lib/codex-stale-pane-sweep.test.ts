import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  notifyCodexPaneBoundForStaleSweep,
  resetCodexStalePaneSweepForTests
} from './codex-stale-pane-sweep'

const ACCOUNT_A = 'account-a@example.com'
const ACCOUNT_B = 'account-b@example.com'

const STALE_PANE = {
  ptyId: 'pty-1',
  launchAccountId: 'account-a',
  activeAccountId: 'account-b'
}

function inspectCallCountFor(ptyId: string): number {
  return vi.mocked(window.api.pty.inspectProcess).mock.calls.filter(([id]) => id === ptyId).length
}

describe('notifyCodexPaneBoundForStaleSweep', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    vi.useFakeTimers()
    resetCodexStalePaneSweepForTests()
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt1',
            title: 'orca-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'codex'
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      pendingCodexPaneRestartIds: {},
      codexRestartNoticeByPtyId: {}
    })
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: false })
        },
        codexAccounts: {
          ...originalWindow?.api?.codexAccounts,
          list: vi.fn().mockResolvedValue({
            accounts: [
              { id: 'account-a', email: ACCOUNT_A },
              { id: 'account-b', email: ACCOUNT_B }
            ],
            activeAccountId: 'account-b'
          }),
          listStalePanes: vi.fn().mockResolvedValue([])
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    resetCodexStalePaneSweepForTests()
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('raises the prompt once the pane PTY actually binds', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    // Nothing inspected yet: the bind has not settled.
    expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('coalesces a burst of startup binds into one sweep', async () => {
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] } })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    notifyCodexPaneBoundForStaleSweep('pty-2')
    await vi.advanceTimersByTimeAsync(300)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledExactlyOnceWith({
      ptyIds: ['pty-1', 'pty-2']
    })
  })

  it('still coalesces a burst whose binds land milliseconds apart', async () => {
    // Real startup binds are staggered, so per-PTY due times must not turn one
    // sweep into one registry round-trip per pane.
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] } })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(10)
    notifyCodexPaneBoundForStaleSweep('pty-2')
    await vi.advanceTimersByTimeAsync(290)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledExactlyOnceWith({
      ptyIds: ['pty-1', 'pty-2']
    })
  })

  it('retries a PTY whose process read is unusable until the reattach settles', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])
    vi.mocked(window.api.pty.inspectProcess).mockRejectedValueOnce(new Error('terminal_gone'))

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})

    await vi.advanceTimersByTimeAsync(1500)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('gives up after a bounded ladder instead of polling forever', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockRejectedValue(new Error('terminal_gone'))

    notifyCodexPaneBoundForStaleSweep('pty-1')
    // Well past the last rung (35.8s), so this pins the ceiling, not the clock.
    await vi.advanceTimersByTimeAsync(120_000)

    expect(window.api.pty.inspectProcess).toHaveBeenCalledTimes(5)
    // Why: the count alone only bounds the first two minutes — a rung past the
    // window would still read as 5. An empty queue is what proves the ladder
    // ended rather than merely moved out of view.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still sweeps a pane whose reattach outlives the first three rungs', async () => {
    // Regression: live Windows 11 runs raised the notice on the third rung
    // (5.8s) in all three samples, i.e. the ladder ended exactly where the
    // slowest measured box landed. A colder reattach falls past it, and the
    // failure is silent — no card, so the pane keeps running the old account.
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])
    vi.mocked(window.api.pty.inspectProcess)
      .mockRejectedValueOnce(new Error('terminal_gone'))
      .mockRejectedValueOnce(new Error('terminal_gone'))
      .mockRejectedValueOnce(new Error('terminal_gone'))

    notifyCodexPaneBoundForStaleSweep('pty-1')
    // t = 5800: rungs 1-3 are spent and nothing has been raised.
    await vi.advanceTimersByTimeAsync(5_800)
    expect(inspectCallCountFor('pty-1')).toBe(3)
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})

    // t = 15800: the fourth rung is the one that catches this pane.
    await vi.advanceTimersByTimeAsync(10_000)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
    expect(inspectCallCountFor('pty-1')).toBe(4)
  })

  it('spends a pane its full retry ladder even when another pane binds later', async () => {
    // Regression: one shared timer used to drain every queued PTY, so a pane
    // already waiting on its 1500ms rung had the next rung consumed by the newer
    // pane's shorter delay — burning through its ladder early and dropping a
    // Windows daemon reattach that had not settled yet.
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] } })
    vi.mocked(window.api.pty.inspectProcess).mockRejectedValue(new Error('terminal_gone'))

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(310)
    notifyCodexPaneBoundForStaleSweep('pty-2')

    // t = 3310: past pty-1's second look (1800), well before its third (5800).
    await vi.advanceTimersByTimeAsync(3_000)
    expect(inspectCallCountFor('pty-1')).toBe(2)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(inspectCallCountFor('pty-1')).toBe(3)
  })

  it('does not park a fresh bind behind a pending retry wait', async () => {
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] } })
    vi.mocked(window.api.pty.inspectProcess).mockRejectedValue(new Error('terminal_gone'))

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(310)
    notifyCodexPaneBoundForStaleSweep('pty-2')
    await vi.advanceTimersByTimeAsync(300)

    // The pending timer was pty-1's 1500ms rung; pty-2 must not inherit that wait.
    expect(inspectCallCountFor('pty-2')).toBe(1)
  })

  it('retries a pane whose sweep threw instead of dropping it', async () => {
    // Why: listStalePanes reads the on-disk pane-account registry and is the one
    // call in the sweep with no catch of its own, so a transient rejection must
    // spend a rung like any other unusable read.
    vi.mocked(window.api.codexAccounts.listStalePanes)
      .mockRejectedValueOnce(new Error('registry unreadable'))
      .mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})

    await vi.advanceTimersByTimeAsync(1500)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('still fires a pane waiting on a later rung when an earlier sweep throws', async () => {
    // Regression: the failing sweep took its own PTYs out of the queue and
    // returned without re-aiming the timer, so pty-1 — parked on its 1500ms rung
    // and never touched by that sweep — was left with nothing to fire it, ever.
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] } })
    vi.mocked(window.api.pty.inspectProcess).mockRejectedValueOnce(new Error('terminal_gone'))
    // Why: keyed on the swept PTY rather than call order, so the rejection stays
    // bound to pty-2's sweep even if the flush sequence changes.
    vi.mocked(window.api.codexAccounts.listStalePanes).mockImplementation(async ({ ptyIds }) => {
      if (ptyIds.includes('pty-2')) {
        throw new Error('registry unreadable')
      }
      return [STALE_PANE]
    })

    notifyCodexPaneBoundForStaleSweep('pty-1')
    // t = 300: pty-1 reads inconclusive and parks on its 1500ms rung (due 1800).
    await vi.advanceTimersByTimeAsync(300)
    notifyCodexPaneBoundForStaleSweep('pty-2')
    // t = 600: pty-2's sweep is the one that throws; pty-1 is not due and untouched.
    await vi.advanceTimersByTimeAsync(300)
    // Why: assert the throw really landed on a sweep pty-1 was absent from, or a
    // later change to the flush sequence could leave this passing while the
    // stranding it exists to catch is no longer being set up at all.
    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-2'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})

    await vi.advanceTimersByTimeAsync(1200)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('stops retrying a pane the registry reports as not stale', async () => {
    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledTimes(1)
  })

  it('does not re-prompt a pane that already got its notice', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledTimes(1)
  })

  it('never marks a plain shell pane, so its input is never blocked', async () => {
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt1',
            title: 'orca-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(window.api.codexAccounts.listStalePanes).not.toHaveBeenCalled()
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('retries a Codex tab still showing its shell, then prompts when Codex is up', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValueOnce({
      foregroundProcess: 'pwsh.exe',
      hasChildProcesses: false
    })

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})

    await vi.advanceTimersByTimeAsync(1500)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('retries a PTY the store has not yet listed against its tab', async () => {
    useAppStore.setState({ ptyIdsByTabId: {} })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()

    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(1500)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })
})
