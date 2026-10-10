import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'

// Why: these cases model a switch made on the focused host, as the status bar does.
const focusedOwner = () => getActiveRuntimeTarget(useAppStore.getState().settings)
import { markLiveCodexSessionsForRestart } from './codex-session-restart'

const ACCOUNT_A = 'account-a@example.com'
const ACCOUNT_B = 'account-b@example.com'
const ACCOUNT_C = 'account-c@example.com'

/** Main's per-PTY record decides a recorded pane's notice, and the switch decides it when main cannot. */
describe('Codex account switch recheck against main', () => {
  const listStalePanes = vi.fn()

  beforeEach(() => {
    listStalePanes.mockReset().mockResolvedValue([])
    useAppStore.setState({
      settings: null,
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
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      pendingCodexPaneRestartIds: {},
      codexRestartNoticeByPtyId: {}
    })
    vi.stubGlobal('window', {
      api: {
        pty: {
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: false }),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null)
        },
        codexAccounts: {
          listRecordedPaneLanes: vi.fn().mockResolvedValue({ 'pty-1': 'host' }),
          listStalePanes
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears an open notice and its queued restart once main reports the pane current', async () => {
    useAppStore.getState().markCodexRestartNotices([
      {
        ptyId: 'pty-1',
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B,
        previousAccountId: 'account-a',
        nextAccountId: 'account-b'
      }
    ])
    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])

    await markLiveCodexSessionsForRestart({
      owner: focusedOwner(),
      previousAccountLabel: ACCOUNT_B,
      nextAccountLabel: ACCOUNT_C,
      previousAccountId: 'account-b',
      nextAccountId: 'account-c'
    })

    expect(listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
  })

  it('falls back to the switch it was given when main cannot answer', async () => {
    listStalePanes.mockRejectedValue(new Error('ipc failed'))

    await markLiveCodexSessionsForRestart({
      owner: focusedOwner(),
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })
})
