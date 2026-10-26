import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  notifyCodexPaneBoundForStaleSweep,
  resetCodexStalePaneSweepForTests,
  sweepRestoredCodexPanesForStaleAccounts
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
      pendingPaneAccountRestarts: {},
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
    expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
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
    // Staggered startup binds must still batch registry reads rather than make one round trip per pane.
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
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })

  it('gives up after a bounded ladder instead of polling forever', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockRejectedValue(new Error('terminal_gone'))

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(120_000)

    expect(window.api.pty.inspectProcess).toHaveBeenCalledTimes(5)
    // An empty queue proves bounded retries ended; counts alone could hide another rung beyond this time window.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still sweeps a pane whose reattach outlives the first three rungs', async () => {
    // The old 5.8s tail matched the slowest measured Windows reattach; colder panes need later bounded retries.
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])
    vi.mocked(window.api.pty.inspectProcess)
      .mockRejectedValueOnce(new Error('terminal_gone'))
      .mockRejectedValueOnce(new Error('terminal_gone'))
      .mockRejectedValueOnce(new Error('terminal_gone'))

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(5_800)
    expect(inspectCallCountFor('pty-1')).toBe(3)
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})

    await vi.advanceTimersByTimeAsync(10_000)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
    expect(inspectCallCountFor('pty-1')).toBe(4)
  })

  it('spends a pane its full retry ladder even when another pane binds later', async () => {
    // A new pane’s short delay must not consume another pane’s later retry before its reattach settles.
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] } })
    vi.mocked(window.api.pty.inspectProcess).mockRejectedValue(new Error('terminal_gone'))

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(310)
    notifyCodexPaneBoundForStaleSweep('pty-2')

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

    expect(inspectCallCountFor('pty-2')).toBe(1)
  })

  it('retries a pane whose sweep threw instead of dropping it', async () => {
    // Registry rejection is inconclusive; spend a retry rung instead of dropping the pane.
    vi.mocked(window.api.codexAccounts.listStalePanes)
      .mockRejectedValueOnce(new Error('registry unreadable'))
      .mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})

    await vi.advanceTimersByTimeAsync(1500)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })

  it('still fires a pane waiting on a later rung when an earlier sweep throws', async () => {
    // A failed sweep must re-arm the timer for untouched panes waiting on later rungs.
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] } })
    vi.mocked(window.api.pty.inspectProcess).mockRejectedValueOnce(new Error('terminal_gone'))
    // Bind the rejection to pty-2, independent of flush order.
    vi.mocked(window.api.codexAccounts.listStalePanes).mockImplementation(async ({ ptyIds }) => {
      if (ptyIds.includes('pty-2')) {
        throw new Error('registry unreadable')
      }
      return [STALE_PANE]
    })

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    notifyCodexPaneBoundForStaleSweep('pty-2')
    await vi.advanceTimersByTimeAsync(300)
    // Prove pty-1 was absent from the throwing sweep so the stranded-later-retry scenario remains covered.
    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-2'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})

    await vi.advanceTimersByTimeAsync(1200)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
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

  it('does not suppress a pane whose notice the store dropped', async () => {
    // A collapsed notice must not permanently suppress the pane: its remembered launch account already equals active account-b.
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        'pty-1': {
          previousAccountLabel: ACCOUNT_B,
          nextAccountLabel: ACCOUNT_A,
          previousAccountId: 'account-b',
          nextAccountId: 'account-a'
        }
      }
    })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeUndefined()
    expect(inspectCallCountFor('pty-1')).toBe(1)

    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)

    expect(inspectCallCountFor('pty-1')).toBe(2)
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
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
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
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })

  // Only daemon host spawns have registry records; remote/SSH retry ladders waste up to five 15s RPCs.
  it.each(['remote:env-1@@term-1', 'remote:term-1', 'ssh:my-box@@pty-7'])(
    'never queues %s, so no rung spends an RPC on it',
    async (ptyId) => {
      useAppStore.setState({ ptyIdsByTabId: { 'tab-1': [ptyId] } })
      vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
        { ptyId, launchAccountId: 'account-a', activeAccountId: 'account-b' }
      ])

      notifyCodexPaneBoundForStaleSweep(ptyId)
      // An unarmed timer proves rejection before queueing; scan-time filtering alone would still waste every rung.
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(120_000)

      expect(vi.getTimerCount()).toBe(0)
      expect(window.api.codexAccounts.listStalePanes).not.toHaveBeenCalled()
      expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
      expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    }
  )

  it('still sweeps the local panes bound alongside a remote one', async () => {
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'remote:env-1@@term-1'] } })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    notifyCodexPaneBoundForStaleSweep('remote:env-1@@term-1')
    notifyCodexPaneBoundForStaleSweep('pty-1')
    await vi.advanceTimersByTimeAsync(300)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledExactlyOnceWith({
      ptyIds: ['pty-1']
    })
    expect(inspectCallCountFor('remote:env-1@@term-1')).toBe(0)
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })

  it('re-raises the prompt for a restored pane whose tab never mounts', async () => {
    // Restored background tabs must get stale-account checks without ever mounting a pane.
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([STALE_PANE])

    sweepRestoredCodexPanesForStaleAccounts({
      ptyIdsByTabId: { 'tab-1': ['pty-1', 'remote:env-1@@term-1'] }
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledExactlyOnceWith({
      ptyIds: ['pty-1']
    })
    expect(inspectCallCountFor('remote:env-1@@term-1')).toBe(0)
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })
})
