import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
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

/**
 * The cached inspection can flap to the pane's shell for a live Codex session
 * (#11064), and the switch path has no retry — one spurious reading silently
 * loses the restart card forever. These pin the fresh-scan re-confirmation.
 */
describe('spurious shell readings on Codex-launched panes', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

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
        },
        runtimeEnvironments: {
          ...originalWindow?.api?.runtimeEnvironments,
          call: runtimeEnvironmentTransportCall
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
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith('pty-1')
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('keeps the pane uncarded when the fresh scan confirms the shell (user exited Codex)', async () => {
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('treats a rejected confirmation as no new evidence', async () => {
    vi.mocked(window.api.pty.confirmForegroundProcess).mockRejectedValue(new Error('daemon busy'))

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('survives a preload without confirmForegroundProcess', async () => {
    ;(
      window.api.pty as unknown as { confirmForegroundProcess?: unknown }
    ).confirmForegroundProcess = undefined

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('never spends the fresh scan on a pane Orca did not launch Codex in', async () => {
    seedPane()

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalled()
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('never spends the fresh scan when the cached reading already answers', async () => {
    vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: true
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeDefined()
    expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('never routes a remote runtime pane through the local confirm bridge', async () => {
    seedPane({ ptyId: 'remote:term-1', launchAgent: 'codex' })
    useAppStore.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { process: { foregroundProcess: 'zsh', hasChildProcesses: false } },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    // Why: a fresh local scan can know nothing about env-1's PTY, and a
    // cross-lane answer must never card (or spare) a remote pane.
    expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalled()
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
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
