import {
  admitTerminalNoticeLifetime,
  getTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import { normalizeTerminalLayoutSnapshot } from '@/components/terminal-pane/layout/terminal-layout-normalization'
import { selectCodexStaleSessionCount } from '@/components/status-bar/codex-restart-status-summary'
import { sweepUnclaimedCodexPaneRestarts } from '@/components/terminal-pane/account-restart/detached/codex-detached-pane-restart'
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
      paneAccountRestarts: {},
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
  it.each([
    ['metadata', 1],
    ['close', 0],
    ['replacement', 0]
  ] as const)(
    'settles an account scan after a %s update against the current pane',
    async (update, count) => {
      const leafId = '00000000-0000-4000-8000-000000000001'
      const layout = {
        root: { type: 'leaf' as const, leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'pty-1' }
      }
      useAppStore.setState({ terminalLayoutsByTabId: { 'tab-1': layout } })
      window.api.codexAccounts.listRecordedPaneLanes = vi
        .fn()
        .mockResolvedValue({ 'pty-1': 'host' })
      vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
        foregroundProcess: 'codex',
        hasChildProcesses: true
      })
      const observed = Promise.withResolvers<void>()
      const stale =
        Promise.withResolvers<
          { ptyId: string; launchAccountId: string; activeAccountId: string }[]
        >()
      vi.mocked(window.api.codexAccounts.listStalePanes).mockImplementation(() => {
        observed.resolve()
        return stale.promise
      })
      const scanning = markLiveCodexSessionsForRestart({
        owner: focusedOwner(),
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      })
      await observed.promise
      if (update === 'metadata') {
        useAppStore.getState().setTabLayout('tab-1', {
          ...layout,
          buffersByLeafId: { [leafId]: 'retained scrollback' }
        })
      } else if (update === 'close') {
        useAppStore.setState({ tabsByWorktree: {}, ptyIdsByTabId: {}, terminalLayoutsByTabId: {} })
      } else {
        useAppStore.setState({
          ptyIdsByTabId: { 'tab-1': ['successor'] },
          terminalLayoutsByTabId: {
            'tab-1': { ...layout, ptyIdsByLeafId: { [leafId]: 'successor' } }
          }
        })
      }
      stale.resolve([
        { ptyId: 'pty-1', launchAccountId: 'account-a', activeAccountId: 'account-b' }
      ])
      await scanning
      expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(count)
    }
  )

  it('drops a delayed scan after its originating tab closes', async () => {
    const inspection = Promise.withResolvers<{
      foregroundProcess: string
      hasChildProcesses: boolean
    }>()
    vi.mocked(window.api.pty.inspectProcess).mockReturnValue(inspection.promise)
    const scanning = markLiveCodexSessionsForRestart({
      owner: focusedOwner(),
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
    useAppStore.setState({ tabsByWorktree: {}, ptyIdsByTabId: {}, terminalLayoutsByTabId: {} })
    inspection.resolve({ foregroundProcess: 'codex', hasChildProcesses: true })
    await scanning
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('shows explicit failure for a reattached rootless legacy session without killing or inventing a leaf', async () => {
    window.api.pty.spawn = vi.fn()
    window.api.pty.kill = vi.fn()
    const tab = { ...useAppStore.getState().tabsByWorktree.wt1[0], worktreeId: 'folder:fixture' }
    const normalized = normalizeTerminalLayoutSnapshot({
      root: null,
      activeLeafId: '0',
      expandedLeafId: null,
      ptyIdsByLeafId: { '0': 'old' }
    }).snapshot
    useAppStore.getState().hydrateWorkspaceSession(
      {
        activeRepoId: null,
        activeWorktreeId: 'folder:fixture',
        activeTabId: 'tab-1',
        tabsByWorktree: { 'folder:fixture': [tab] },
        terminalLayoutsByTabId: { 'tab-1': normalized }
      },
      { additionalValidWorkspaceKeys: ['folder:fixture'] }
    )
    useAppStore.getState().updateTabPtyId('tab-1', 'old')
    window.api.pty.inspectProcess = vi
      .fn()
      .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: true })
    await markLiveCodexSessionsForRestart({
      owner: focusedOwner(),
      previousAccountLabel: 'old',
      nextAccountLabel: 'new'
    })
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
    await sweepUnclaimedCodexPaneRestarts()
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1'].root).toBeNull()
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })
  it('drops a delayed same-ID scan when its admitted process incarnation was replaced', async () => {
    const initial = admitTerminalNoticeLifetime('pty-1', { incarnationId: 'inc-old', fresh: true })
    const inspection = Promise.withResolvers<{
      foregroundProcess: string
      hasChildProcesses: boolean
    }>()
    vi.mocked(window.api.pty.inspectProcess).mockReturnValue(inspection.promise)
    const scanning = markLiveCodexSessionsForRestart({
      owner: focusedOwner(),
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
    admitTerminalNoticeLifetime('pty-1', { incarnationId: 'inc-successor', fresh: true })
    inspection.resolve({ foregroundProcess: 'codex', hasChildProcesses: true })
    await scanning
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'codex')
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
    const current = getTerminalNoticeLifetime('pty-1')
    if (current) {
      retireTerminalNoticeLifetime(current)
    }
    retireTerminalNoticeLifetime(initial)
  })
})
