import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'

// Why: these cases model a switch made on the focused host, as the status bar does.
const focusedOwner = () => defaultScopeHost(useAppStore.getState().settings)
import {
  markLiveCodexSessionsForRestart,
  markRestoredStaleCodexSessionsForRestart
} from './codex-session-restart'

const ACCOUNT_A = 'account-a@example.com'
const ACCOUNT_B = 'account-b@example.com'

// Reconfirm cached shell readings: one transient flap during account switch would silently lose the only restart notice (#11064).
describe('spurious shell readings on Codex-launched panes', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  function seedPane(args: { ptyId?: string; launchAgent?: 'codex' } = {}): void {
    const ptyId = args.ptyId ?? 'pty-1'
    useAppStore.setState({
      settings: null as never,
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId,
            worktreeId: 'wt1',
            title: 'orca-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ...(args.launchAgent ? { launchAgent: args.launchAgent } : {})
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': [ptyId] },
      pendingPaneAccountRestarts: {},
      codexRestartNoticeByPtyId: {}
    })
  }

  beforeEach(() => {
    seedPane({ launchAgent: 'codex' })
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: 'zsh', hasChildProcesses: false }),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null)
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
    useAppStore.setState({ settings: null as never })
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('re-confirms with the fresh scan and cards the pane when codex still owns it', async () => {
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('codex-aarch64-ap')

    await markLiveCodexSessionsForRestart({
      owner: focusedOwner(),
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith('pty-1')
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('heals a spurious shell reading before the restored-pane stale lookup', async () => {
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('codex')
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      { ptyId: 'pty-1', launchAccountId: 'account-a', activeAccountId: 'account-b' }
    ])

    await markRestoredStaleCodexSessionsForRestart()

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })
})
