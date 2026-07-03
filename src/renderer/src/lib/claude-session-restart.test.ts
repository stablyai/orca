import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  getLiveClaudeSessionRestartPlan,
  markClaudeSessionsForRestart
} from './claude-session-restart'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getDefaultSettings } from '../../../shared/constants'

const ACCOUNT_A = 'account-a@example.com'
const ACCOUNT_B = 'account-b@example.com'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

describe('Claude session restart planning', () => {
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
            title: 'Terminal 1',
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
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      runtimePaneTitlesByTabId: {},
      agentStatusByPaneKey: {},
      pendingClaudePaneRestartIds: {},
      claudeRestartNoticeByPtyId: {}
    })

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          getForegroundProcess: vi.fn(),
          hasChildProcesses: vi.fn().mockResolvedValue(false)
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

  it('marks a live Claude PTY for restart', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('claude')

    const plan = await getLiveClaudeSessionRestartPlan()
    markClaudeSessionsForRestart({
      ptyIds: plan.livePtyIds,
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(window.api.pty.getForegroundProcess).toHaveBeenCalledWith('pty-1')
    expect(plan).toEqual({ livePtyIds: ['pty-1'], workInProgressPtyIds: [] })
    expect(useAppStore.getState().claudeRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('can force a restart when Claude credentials changed without a label change', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('claude')

    const plan = await getLiveClaudeSessionRestartPlan()
    markClaudeSessionsForRestart({
      ptyIds: plan.livePtyIds,
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_A,
      forceRestart: true
    })

    expect(useAppStore.getState().claudeRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_A
    })
  })

  it('treats Claude executable variants as Claude sessions', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('claude.exe')

    await expect(getLiveClaudeSessionRestartPlan()).resolves.toEqual({
      livePtyIds: ['pty-1'],
      workInProgressPtyIds: []
    })

    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('claude-code')

    await expect(getLiveClaudeSessionRestartPlan()).resolves.toEqual({
      livePtyIds: ['pty-1'],
      workInProgressPtyIds: []
    })
  })

  it('uses Claude hook state to warn about work in progress', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('node')
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'finish migration',
          updatedAt: 1,
          stateStartedAt: 1,
          agentType: 'claude',
          stateHistory: []
        }
      }
    })

    await expect(getLiveClaudeSessionRestartPlan()).resolves.toEqual({
      livePtyIds: ['pty-1'],
      workInProgressPtyIds: ['pty-1']
    })
  })

  it('uses single-pane Claude titles as an active work fallback', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('node')
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt1',
            title: '. write account switcher',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })

    await expect(getLiveClaudeSessionRestartPlan()).resolves.toEqual({
      livePtyIds: ['pty-1'],
      workInProgressPtyIds: ['pty-1']
    })
  })

  it('does not restart split siblings from a tab-wide Claude title alone', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('zsh')
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'pty-2',
            worktreeId: 'wt1',
            title: '. write account switcher',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1', 'pty-2']
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      }
    })

    await expect(getLiveClaudeSessionRestartPlan()).resolves.toEqual({
      livePtyIds: [],
      workInProgressPtyIds: []
    })
  })

  it('inspects remote runtime PTYs through the active runtime environment', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' },
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'remote:term-1',
            worktreeId: 'wt1',
            title: 'Terminal 1',
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
        process: { foregroundProcess: 'claude', hasChildProcesses: true }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(getLiveClaudeSessionRestartPlan()).resolves.toEqual({
      livePtyIds: ['remote:term-1'],
      workInProgressPtyIds: []
    })

    expect(window.api.pty.getForegroundProcess).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.inspectProcess',
      params: { terminal: 'term-1' },
      timeoutMs: 15_000
    })
  })
})
