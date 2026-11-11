import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
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
})
