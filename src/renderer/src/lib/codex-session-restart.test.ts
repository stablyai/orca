import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { shouldUseShellReadyStartupDelivery } from '../../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  CODEX_ACCOUNT_RESTART_STARTUP,
  markLiveCodexSessionsForRestart,
  markRestoredStaleCodexSessionsForRestart
} from './codex-session-restart'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { liveRemoteEvidence } from './codex-session-restart-test-fixture'

const ACCOUNT_A = 'account-a@example.com'
const ACCOUNT_B = 'account-b@example.com'
const ACCOUNT_C = 'account-c@example.com'

function setLaunchAgentOnFirstTab(launchAgent: TuiAgent): void {
  const [tab, ...rest] = useAppStore.getState().tabsByWorktree.wt1 ?? []
  if (!tab) {
    throw new Error('expected a seeded tab')
  }
  useAppStore.setState({ tabsByWorktree: { wt1: [{ ...tab, launchAgent }, ...rest] } })
}

describe('CODEX_ACCOUNT_RESTART_STARTUP', () => {
  it('waits for shell readiness before relaunching Codex after an account switch', () => {
    // Why launchAgent is load-bearing: pty:spawn runs the managed-auth
    // readiness gate and Codex launch prep only for launchAgent 'codex', so
    // dropping it would let a restart respawn race the account handoff and
    // record a launch account the pane does not actually read.
    expect(CODEX_ACCOUNT_RESTART_STARTUP).toEqual({
      command: 'codex',
      startupCommandDelivery: 'shell-ready',
      launchAgent: 'codex'
    })
    expect(shouldUseShellReadyStartupDelivery(CODEX_ACCOUNT_RESTART_STARTUP)).toBe(true)
  })
})

describe('markLiveCodexSessionsForRestart', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    useAppStore.setState({
      // Why: a prior test's remote-runtime selection must not silently move
      // every later local pane out of the switch's lane.
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
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      pendingCodexPaneRestartIds: {},
      codexRestartNoticeByPtyId: {},
      markCodexRestartNotices: useAppStore.getState().markCodexRestartNotices
    })

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          getForegroundProcess: vi.fn(),
          hasChildProcesses: vi.fn().mockResolvedValue(false),
          inspectProcess: vi.fn(),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null)
        },
        codexAccounts: {
          ...originalWindow?.api?.codexAccounts,
          list: vi.fn().mockResolvedValue({
            accounts: [{ id: 'account-a', email: ACCOUNT_A }],
            activeAccountId: null
          }),
          listStalePanes: vi.fn().mockResolvedValue([])
        },
        runtimeEnvironments: {
          ...originalWindow?.api?.runtimeEnvironments,
          call: runtimeEnvironmentTransportCall
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

  it('marks a live Codex PTY for restart', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: false
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(window.api.pty.inspectProcess).toHaveBeenCalledWith('pty-1')
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
    expect(window.api.codexAccounts.listStalePanes).not.toHaveBeenCalled()
  })

  it('marks every live Codex split pane and ignores non-Codex panes', async () => {
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
          },
          {
            id: 'tab-2',
            ptyId: 'pty-3',
            worktreeId: 'wt1',
            title: 'orca-2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1', 'pty-2'],
        'tab-2': ['pty-3']
      }
    })
    vi.mocked(window.api.pty.inspectProcess).mockImplementation(async (ptyId) => {
      const foregroundProcess =
        ptyId === 'pty-1' ? 'codex' : ptyId === 'pty-3' ? 'codex-aarch64-ap' : 'zsh'
      return { foregroundProcess, hasChildProcesses: false }
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({
      'pty-1': {
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      },
      'pty-3': {
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      }
    })
  })

  it('does not mark non-codex foreground processes', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('marks a launcher-started Codex pane whose deepest process is a subagent', async () => {
    // Windows reports pwsh -> node -> codex.exe -> claude.exe as "claude".
    setLaunchAgentOnFirstTab('codex')
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'claude.exe',
      hasChildProcesses: true
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('leaves a Codex-launched pane alone once the user exits back to the shell', async () => {
    setLaunchAgentOnFirstTab('codex')
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'pwsh.exe',
      hasChildProcesses: false
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    // Why: a restart notice drops every keystroke in that pane.
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('leaves a Codex-launched pane alone while the user is inside their own program', async () => {
    // Why: the switch path never consults the stale-pane registry, so an exited
    // Codex tab now running a pager would lose the keystrokes needed to quit it.
    setLaunchAgentOnFirstTab('codex')
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'less',
      hasChildProcesses: true
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('still marks a confirmed Codex pane when another pane is unreachable', async () => {
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-stale'] } })
    vi.mocked(window.api.pty.inspectProcess).mockImplementation(async (ptyId) => {
      if (ptyId === 'pty-stale') {
        throw new Error('terminal_gone')
      }
      return { foregroundProcess: 'codex', hasChildProcesses: true }
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({
      'pty-1': {
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      }
    })
  })

  it('treats codex.exe as codex for Windows PTYs', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'codex.exe',
      hasChildProcesses: false
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('treats codex-prefixed packaged binaries as codex', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'codex-aarch64-ap',
      hasChildProcesses: false
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('clears stale restart notices when the selected account switches back to the live pane account', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: false
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_B,
      nextAccountLabel: ACCOUNT_A
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
  })

  it('keeps a requested restart answered when the account switches again first', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: false
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])
    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_B,
      nextAccountLabel: 'account-c@example.com'
    })

    // Why: the queued restart relaunches under whatever account is selected when
    // it runs, so a third switch must not reopen a prompt the user answered.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: 'account-c@example.com',
      restartRequested: true
    })
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ 'pty-1': true })
  })

  it('preserves the pane original account across repeated switches until restart', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: false
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_B,
      nextAccountLabel: ACCOUNT_C
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_C
    })
  })

  it('inspects remote runtime PTYs through the active runtime environment', async () => {
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'remote:term-1',
            worktreeId: 'wt1',
            title: 'orca-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:term-1']
      }
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        process: {
          foregroundProcess: 'codex',
          hasChildProcesses: true,
          foregroundProcessEvidence: liveRemoteEvidence('term-1')
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.inspectProcess',
      params: { terminal: 'term-1' },
      timeoutMs: 15_000
    })
    expect(useAppStore.getState().codexRestartNoticeByPtyId['remote:term-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })
})

/**
 * A restart notice blocks every keystroke in the pane it names, so raising one
 * on a pane the switch could not have touched takes a working terminal deaf.
 * A managed Codex account is scoped to one machine AND one runtime: a remote
 * spawn carries a connectionId, so no CODEX_HOME is ever injected into it, and
 * WSL selections live in their own per-distro slot.
 */
describe('markLiveCodexSessionsForRestart lane scoping', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  function seedPanes(
    panes: { ptyId: string; worktreeId?: string; shellOverride?: string }[],
    worktreePaths: Record<string, string> = {}
  ): void {
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      worktreesByRepo: {
        repo1: [
          { id: 'wt1', path: worktreePaths.wt1 ?? '/Users/dev/code/orca' },
          ...(worktreePaths.wt2 ? [{ id: 'wt2', path: worktreePaths.wt2 }] : [])
        ]
      } as never,
      tabsByWorktree: {
        wt1: panes.map((pane, index) => ({
          id: `tab-${index}`,
          ptyId: pane.ptyId,
          worktreeId: pane.worktreeId ?? 'wt1',
          title: `orca-${index}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: 1,
          launchAgent: 'codex' as const,
          ...(pane.shellOverride ? { shellOverride: pane.shellOverride } : {})
        }))
      },
      ptyIdsByTabId: Object.fromEntries(panes.map((pane, index) => [`tab-${index}`, [pane.ptyId]])),
      pendingCodexPaneRestartIds: {},
      codexRestartNoticeByPtyId: {}
    })
  }

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    // Why: every pane in this block reads as a live Codex session, so any pane
    // left uncarded was excluded by its lane and nothing else.
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        process: {
          foregroundProcess: 'codex',
          hasChildProcesses: true,
          foregroundProcessEvidence: liveRemoteEvidence('term-1')
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: true })
        },
        codexAccounts: {
          ...originalWindow?.api?.codexAccounts,
          list: vi.fn().mockResolvedValue({ accounts: [], activeAccountId: null }),
          listStalePanes: vi.fn().mockResolvedValue([]),
          listRecordedPaneLanes: vi.fn().mockResolvedValue({})
        },
        runtimeEnvironments: {
          ...originalWindow?.api?.runtimeEnvironments,
          call: runtimeEnvironmentTransportCall
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    useAppStore.setState({ settings: null as never, worktreesByRepo: {} as never })
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('leaves a live remote Codex pane alone on a host switch, and never inspects it', async () => {
    seedPanes([{ ptyId: 'remote:env-1@@term-1' }])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      target: { runtime: 'host' }
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('leaves a live SSH-connection Codex pane alone on a host switch', async () => {
    seedPanes([{ ptyId: 'ssh:my-box@@pty-7' }])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      target: { runtime: 'host' }
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
  })

  it('still marks the local host pane while sparing the remote one beside it', async () => {
    seedPanes([{ ptyId: 'pty-1' }, { ptyId: 'remote:env-1@@term-1' }])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      target: { runtime: 'host' }
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({
      'pty-1': { previousAccountLabel: ACCOUNT_A, nextAccountLabel: ACCOUNT_B }
    })
    expect(window.api.pty.inspectProcess).toHaveBeenCalledWith('pty-1')
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('still marks a local host pane when the switch names no target at all', async () => {
    seedPanes([{ ptyId: 'pty-1' }])

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({
      'pty-1': { previousAccountLabel: ACCOUNT_A, nextAccountLabel: ACCOUNT_B }
    })
  })

  // Why these two: a Windows validation saw a WSL pane escape a host switch, but
  // only because its foreground read as `wsl.exe` and failed the Codex test. Pin
  // the lane instead — a WSL pane whose foreground IS codex must escape too.
  it('leaves a WSL Codex pane alone on a host switch even when its foreground is codex', async () => {
    seedPanes([{ ptyId: 'pty-wsl' }], { wt1: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      target: { runtime: 'host' }
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
  })

  it('marks that same WSL pane when its own distro is the lane that changed', async () => {
    seedPanes([{ ptyId: 'pty-wsl' }], { wt1: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({
      'pty-wsl': { previousAccountLabel: ACCOUNT_A, nextAccountLabel: ACCOUNT_B }
    })
  })

  it('keeps one distro switch off another distro pane', async () => {
    seedPanes([{ ptyId: 'pty-wsl' }], { wt1: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      target: { runtime: 'wsl', wslDistro: 'Debian' }
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('leaves the local host pane alone when the switch was made on a runtime environment', async () => {
    seedPanes([{ ptyId: 'pty-1' }, { ptyId: 'remote:env-1@@term-1' }])
    useAppStore.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      target: { runtime: 'host' }
    })

    // Why: that mutation was RPC'd to env-1's own roster, so env-1's panes are
    // the stale ones and the local shell is untouched — the mirror of the bug.
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({
      'remote:env-1@@term-1': {
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      }
    })
    expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
  })

  /**
   * Main writes the lane from the shell, cwd and distro the spawn resolved, so
   * it is exact where re-deriving from current state can only approximate. Four
   * review rounds each found another divergence in that derivation; these pin
   * the record beating it in both directions.
   */
  describe('recorded launch lanes', () => {
    it('spares a pane the record puts in another lane, and never inspects it', async () => {
      // Derivation says `host`; the pane really launched under WSL. Carding it
      // would take a working terminal deaf — this is the bug class in one test.
      seedPanes([{ ptyId: 'pty-1' }])
      vi.mocked(window.api.codexAccounts.listRecordedPaneLanes).mockResolvedValue({
        'pty-1': 'wsl:Ubuntu'
      })

      await markLiveCodexSessionsForRestart({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B,
        target: { runtime: 'host' }
      })

      expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
      expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
    })

    it('cards a pane the record puts in the switched lane against the derivation', async () => {
      // The mirror: the user changed a runtime preference after this WSL-looking
      // pane spawned on the host, and re-derivation would now miss its notice.
      seedPanes([{ ptyId: 'pty-1' }], { wt1: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' })
      vi.mocked(window.api.codexAccounts.listRecordedPaneLanes).mockResolvedValue({
        'pty-1': 'host'
      })
      vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
        {
          ptyId: 'pty-1',
          launchAccountId: 'account-a',
          activeAccountId: 'account-b',
          reason: 'account-change'
        }
      ])

      await markLiveCodexSessionsForRestart({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B,
        previousAccountId: 'account-a',
        nextAccountId: 'account-b',
        target: { runtime: 'host' }
      })

      expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B,
        previousAccountId: 'account-a',
        nextAccountId: 'account-b'
      })
    })

    it('suppresses a null-to-account reauth notice when the recorded pane is already current', async () => {
      seedPanes([{ ptyId: 'pty-1' }])
      vi.mocked(window.api.codexAccounts.listRecordedPaneLanes).mockResolvedValue({
        'pty-1': 'host'
      })

      await markLiveCodexSessionsForRestart({
        previousAccountLabel: 'System default',
        nextAccountLabel: ACCOUNT_A,
        previousAccountId: null,
        nextAccountId: 'account-a',
        target: { runtime: 'host' }
      })

      expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({
        ptyIds: ['pty-1']
      })
      expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    })

    it('classifies current, stale, and unrecorded panes independently', async () => {
      seedPanes([{ ptyId: 'pty-current' }, { ptyId: 'pty-stale' }, { ptyId: 'pty-unknown' }])
      vi.mocked(window.api.codexAccounts.listRecordedPaneLanes).mockResolvedValue({
        'pty-current': 'host',
        'pty-stale': 'host'
      })
      vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
        {
          ptyId: 'pty-stale',
          launchAccountId: 'account-a',
          activeAccountId: 'account-b',
          reason: 'account-change'
        }
      ])

      await markLiveCodexSessionsForRestart({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B,
        previousAccountId: 'account-a',
        nextAccountId: 'account-b',
        target: { runtime: 'host' }
      })

      expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({
        ptyIds: ['pty-current', 'pty-stale']
      })
      expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({
        'pty-stale': {
          previousAccountLabel: ACCOUNT_A,
          nextAccountLabel: ACCOUNT_B,
          previousAccountId: 'account-a',
          nextAccountId: 'account-b'
        },
        'pty-unknown': {
          previousAccountLabel: ACCOUNT_A,
          nextAccountLabel: ACCOUNT_B,
          previousAccountId: 'account-a',
          nextAccountId: 'account-b'
        }
      })
    })

    // THE regression check: over-filtering silently kills the feature and reads
    // as a pass. A genuine local host pane must be carded on every fallback path.
    it.each([
      ['no record exists for the pane', () => ({ 'pty-other': 'wsl:Ubuntu' })],
      ['the lookup rejects', null],
      ['the preload predates the lookup', undefined]
    ])('still cards a local host pane when %s', async (_label, recorded) => {
      seedPanes([{ ptyId: 'pty-1' }])
      if (recorded === null) {
        vi.mocked(window.api.codexAccounts.listRecordedPaneLanes).mockRejectedValue(
          new Error('no handler')
        )
      } else if (recorded === undefined) {
        ;(
          window.api.codexAccounts as unknown as { listRecordedPaneLanes?: unknown }
        ).listRecordedPaneLanes = undefined
      } else {
        vi.mocked(window.api.codexAccounts.listRecordedPaneLanes).mockResolvedValue(recorded())
      }

      await markLiveCodexSessionsForRestart({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B,
        target: { runtime: 'host' }
      })

      expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      })
    })

    it('asks only about panes main could have recorded', async () => {
      seedPanes([
        { ptyId: 'pty-1' },
        { ptyId: 'remote:env-1@@term-1' },
        { ptyId: 'ssh:my-box@@pty-7' }
      ])

      await markLiveCodexSessionsForRestart({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B,
        target: { runtime: 'host' }
      })

      // Why: main only records daemon host spawns, so a foreign id is a certain
      // miss — and one batched call, not one per pane.
      expect(window.api.codexAccounts.listRecordedPaneLanes).toHaveBeenCalledTimes(1)
      expect(window.api.codexAccounts.listRecordedPaneLanes).toHaveBeenCalledWith({
        ptyIds: ['pty-1']
      })
    })
  })
})

describe('markRestoredStaleCodexSessionsForRestart', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
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
          getForegroundProcess: vi.fn(),
          hasChildProcesses: vi.fn().mockResolvedValue(false),
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: false }),
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
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('re-raises the prompt for a pane the app restart forgot', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      { ptyId: 'pty-1', launchAccountId: 'account-a', activeAccountId: 'account-b' }
    ])

    await markRestoredStaleCodexSessionsForRestart()

    expect(window.api.codexAccounts.listStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })

  it('keeps a system-default home-route change as a restart notice', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      {
        ptyId: 'pty-1',
        launchAccountId: null,
        activeAccountId: null,
        reason: 'home-route-change'
      }
    ])

    await markRestoredStaleCodexSessionsForRestart()

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: 'System default',
      nextAccountLabel: 'System default',
      previousAccountId: null,
      nextAccountId: null,
      homeRouteChanged: true
    })
  })

  it('labels the system default when a pane launched without a managed account', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      { ptyId: 'pty-1', launchAccountId: null, activeAccountId: 'account-b' }
    ])

    await markRestoredStaleCodexSessionsForRestart()

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']?.previousAccountLabel).toBe(
      'System default'
    )
  })

  it('prompts nothing when every restored pane is on the selected account', async () => {
    await markRestoredStaleCodexSessionsForRestart()

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('skips the account lookup entirely when no pane is running Codex', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })

    await markRestoredStaleCodexSessionsForRestart()

    expect(window.api.codexAccounts.listStalePanes).not.toHaveBeenCalled()
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })
})
