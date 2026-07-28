import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { shouldUseShellReadyStartupDelivery } from '../../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../../shared/types'
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
    expect(CODEX_ACCOUNT_RESTART_STARTUP).toEqual({
      command: 'codex',
      startupCommandDelivery: 'shell-ready'
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
          inspectProcess: vi.fn()
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
        process: { foregroundProcess: 'codex', hasChildProcesses: true }
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
      nextAccountLabel: ACCOUNT_B
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
