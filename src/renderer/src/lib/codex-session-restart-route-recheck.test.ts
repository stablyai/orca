import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { markLiveCodexSessionsForRestart } from './codex-session-restart'

const ACCOUNT_A = 'account-a@example.com'
const ACCOUNT_B = 'account-b@example.com'
const SYSTEM_DEFAULT = 'System default'
const originalWindow = (globalThis as { window?: typeof window }).window

function seedRouteNotice(args: {
  previousAccountId: string | null
  previousAccountLabel: string
}): void {
  useAppStore.getState().markCodexRestartNotices([
    {
      ptyId: 'pty-1',
      previousAccountLabel: args.previousAccountLabel,
      nextAccountLabel: SYSTEM_DEFAULT,
      previousAccountId: args.previousAccountId,
      nextAccountId: null,
      homeRouteChanged: true
    }
  ])
}

describe('Codex restored route notice recheck', () => {
  beforeEach(() => {
    useAppStore.setState({
      settings: null as never,
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
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: false }),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null)
        },
        codexAccounts: {
          ...originalWindow?.api?.codexAccounts,
          listRecordedPaneLanes: vi.fn().mockResolvedValue({ 'pty-1': 'host' }),
          listStalePanes: vi.fn().mockResolvedValue([])
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('clears the notice when main confirms the launch account and route are restored', async () => {
    seedRouteNotice({ previousAccountId: 'account-a', previousAccountLabel: ACCOUNT_A })
    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: SYSTEM_DEFAULT,
      nextAccountLabel: ACCOUNT_A,
      previousAccountId: null,
      nextAccountId: 'account-a'
    })

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
  })

  it('keeps the notice while shared-home still differs from real-home', async () => {
    seedRouteNotice({ previousAccountId: null, previousAccountLabel: SYSTEM_DEFAULT })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      {
        ptyId: 'pty-1',
        launchAccountId: null,
        activeAccountId: null,
        reason: 'home-route-change'
      }
    ])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_B,
      nextAccountLabel: SYSTEM_DEFAULT,
      previousAccountId: 'account-b',
      nextAccountId: null
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: SYSTEM_DEFAULT,
      nextAccountLabel: SYSTEM_DEFAULT,
      previousAccountId: null,
      nextAccountId: null,
      homeRouteChanged: true
    })
  })

  it('downgrades the notice when only the launch account remains stale', async () => {
    seedRouteNotice({ previousAccountId: 'account-a', previousAccountLabel: ACCOUNT_A })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      {
        ptyId: 'pty-1',
        launchAccountId: 'account-a',
        activeAccountId: 'account-b',
        reason: 'account-change'
      }
    ])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: SYSTEM_DEFAULT,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: null,
      nextAccountId: 'account-b'
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })

  it('preserves the notice when the authoritative recheck fails', async () => {
    seedRouteNotice({ previousAccountId: 'account-a', previousAccountLabel: ACCOUNT_A })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockRejectedValue(new Error('ipc failed'))

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: SYSTEM_DEFAULT,
      nextAccountLabel: ACCOUNT_A,
      previousAccountId: null,
      nextAccountId: 'account-a'
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_A,
      previousAccountId: 'account-a',
      nextAccountId: 'account-a',
      homeRouteChanged: true
    })
  })
})
