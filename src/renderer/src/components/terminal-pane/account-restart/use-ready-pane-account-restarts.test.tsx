// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { buildPaneAccountRestartStartup } from '@/lib/agent-session/accounts/agent-account-restart-startup'
import {
  handleRunningClaudeSessionsAfterSwitch,
  resetClaudeAccountSwitchSessionsForTests
} from '@/lib/provider-accounts/claude-account-switch-sessions'
import type { AgentProviderSessionMetadata } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type * as paneSelectionLane from '@/lib/agent-session/accounts/codex-pane-selection-lane'
import type * as sonner from 'sonner'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import {
  recordQueuedClaudeRestarts,
  takeQueuedClaudeRestart
} from '@/lib/agent-session/accounts/claude/claude-queued-restart-records'
import { useReadyPaneAccountRestarts } from './use-ready-pane-account-restarts'
import { requeueRestart } from './discovered-claude-restart'
import { useTerminalPaneLayoutBindings } from '../layout/ownership/use-terminal-pane-layout-bindings'
import type { TerminalPaneLayoutController } from '../layout/persistence/use-terminal-pane-layout-persistence'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'pty-old'
const STARTUP = { command: "claude --resume 'session-a'" }
const LAYOUT = {
  root: { type: 'leaf' as const, leafId: LEAF },
  activeLeafId: LEAF,
  expandedLeafId: null,
  ptyIdsByLeafId: { [LEAF]: OLD_PTY }
}

let attachedPtyId: string | null = null
const transport = { getPtyId: () => attachedPtyId }
const managerRef = { current: { getPanes: () => [{ id: 1, leafId: LEAF }] } }
const paneTransportsRef = { current: new Map([[1, transport]]) }
const buildAccountRestartStartup = () => STARTUP
const handleRestartPane = vi.fn()

function seedWorkingClaudePane(setting: ClaudeAccountSwitchRunningSessions): void {
  const paneKey = `tab-1:${LEAF}`
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/dev'), claudeAccountSwitchRunningSessions: setting },
    terminalLayoutsByTabId: { 'tab-1': LAYOUT },
    agentStatusByPaneKey: acceptedAgentStatuses(
      Object.entries({
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          agentType: 'claude',
          state: 'working',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'session-a' }
        }
      })
    )
  })
}

function queueFromSwitch(setting: ClaudeAccountSwitchRunningSessions): void {
  recordQueuedClaudeRestarts([OLD_PTY], setting === 'restart-all')
  useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'claude')
}

function renderReadyPaneAccountRestarts(build: unknown = buildAccountRestartStartup): void {
  const consumePendingPaneAccountRestart = useAppStore.getState().consumePendingPaneAccountRestart
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only getPanes, getPtyId and the stubs passed here
  const args = {
    consumePendingPaneAccountRestart,
    managerRef,
    paneTransportsRef,
    tabId: 'tab-1',
    buildAccountRestartStartup: build,
    handleRestartPane,
    panePtyLayoutBindings: LAYOUT.ptyIdsByLeafId
  } as unknown as Parameters<typeof useReadyPaneAccountRestarts>[0]
  renderHook(() => useReadyPaneAccountRestarts(args))
}

function renderLayoutBindings() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the leaf bind reads only tabId, the refs and setTabLayout; the rest are inert stubs
  const controller = {
    tabId: 'tab-1',
    managerRef,
    paneTransportsRef,
    setTabLayout: useAppStore.getState().setTabLayout,
    containerRef: { current: null },
    expandedPaneIdRef: { current: null },
    expandedStyleSnapshotRef: { current: new Map() },
    pendingPaneSizeRefreshFrameIdsRef: { current: [] },
    persistLayoutSnapshot: vi.fn(),
    setExpandedPaneId: vi.fn(),
    setTabPaneExpanded: vi.fn()
  } as unknown as TerminalPaneLayoutController
  return renderHook(() => useTerminalPaneLayoutBindings(controller))
}

describe('on-screen Claude account restart readiness', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    handleRestartPane.mockReset()
    attachedPtyId = null
  })

  afterEach(cleanup)

  it.each(['restart-all', 'restart'] as const)(
    'under %s, a working pane queued now restarts at once',
    (setting) => {
      seedWorkingClaudePane(setting)
      attachedPtyId = OLD_PTY
      renderReadyPaneAccountRestarts()

      act(() => queueFromSwitch(setting))

      expect(handleRestartPane.mock.calls).toEqual([[1, STARTUP, { focus: false }]])
      expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    }
  )

  it.each(['restart-all', 'restart'] as const)(
    'under %s, a working pane queued before its same-id reattach restarts at bind',
    async (setting) => {
      seedWorkingClaudePane(setting)
      renderReadyPaneAccountRestarts()
      const bindings = renderLayoutBindings()

      act(() => queueFromSwitch(setting))
      expect(handleRestartPane).not.toHaveBeenCalled()
      await act(async () => {
        attachedPtyId = OLD_PTY
        bindings.result.current.syncPanePtyLayoutBindingForLeaf(LEAF, OLD_PTY, 1)
      })

      expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']).toBe(LAYOUT)
      expect(handleRestartPane.mock.calls).toEqual([[1, STARTUP, { focus: false }]])
      expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    }
  )

  it('under restart-all, a working pane queued before its terminal is rebound restarts at the rebind', () => {
    seedWorkingClaudePane('restart-all')
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: OLD_PTY,
            worktreeId: 'wt1',
            title: 'claude',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': [OLD_PTY] }
    })
    renderReadyPaneAccountRestarts()
    act(() => queueFromSwitch('restart-all'))
    expect(handleRestartPane).not.toHaveBeenCalled()

    act(() => {
      attachedPtyId = 'pty-rot'
      useAppStore.getState().updateTabPtyId('tab-1', 'pty-rot', OLD_PTY)
    })

    expect(handleRestartPane.mock.calls).toEqual([[1, STARTUP, { focus: false }]])
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })
})

vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof sonner>()),
  toast: { success: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  translate: (key: string) => key
}))
vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))
vi.mock('@/runtime/hosts/preflight/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/lib/agent-session/accounts/codex-pane-selection-lane', async (importOriginal) => ({
  ...(await importOriginal<typeof paneSelectionLane>()),
  resolveCodexPaneSelectionLane: () => ({
    laneKey: 'host',
    source: 'derived',
    derivedLaneKey: null
  })
}))

describe('on-screen restart of a Claude pane no hook named', () => {
  const PANE_KEY = `tab-1:${LEAF}`
  const FOLDER_A = '/data/claude-accounts/acct-a'
  const SESSION = 'session-a'
  const record = {
    key: 'session_id',
    id: SESSION,
    transcriptPath: `${FOLDER_A}/projects/-r/${SESSION}.jsonl`
  }
  const discoverClaudeSession = vi.fn()
  const accounts = ['acct-a', 'acct-b'].map((id) => ({
    id,
    email: `${id}@example.com`,
    authMethod: 'subscription-oauth' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }))
  const hostFolders = {
    accounts: accounts.map((entry) => ({ ...entry, home: `/data/claude-accounts/${entry.id}` })),
    systemDefaultHome: '/home/dev/.claude'
  }
  const realBuild = (
    agent: AccountRestartAgent,
    leafId: string,
    ...rest: [AgentProviderSessionMetadata?, boolean?, boolean?]
  ) => buildPaneAccountRestartStartup(agent, { tabId: 'tab-1', worktreeId: 'wt1', leafId }, ...rest)
  const switchAccount = () =>
    handleRunningClaudeSessionsAfterSwitch({
      owner: { kind: 'local' },
      target: { runtime: 'host' },
      before: { state: hostFolders, accountId: 'acct-a' },
      after: { state: hostFolders, accountId: 'acct-b' }
    })
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    resetClaudeAccountSwitchSessionsForTests()
    handleRestartPane.mockReset()
    vi.mocked(toast.warning).mockClear()
    attachedPtyId = OLD_PTY
    discoverClaudeSession.mockReset().mockResolvedValue(record)
    Object.assign(window, { api: { pty: { discoverClaudeSession } } })
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'claude',
      hasChildProcesses: true
    })
    seedWorkingClaudePane('restart-all')
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        claudeManagedAccounts: accounts.map((entry) => ({
          ...entry,
          managedAuthPath: `/data/claude-accounts/${entry.id}`
        }))
      },
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: OLD_PTY,
            worktreeId: 'wt1',
            title: 'claude',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': [OLD_PTY] },
      agentStatusByPaneKey: acceptedAgentStatuses([
        [
          PANE_KEY,
          {
            ...state.agentStatusByPaneKey.get(PANE_KEY)!,
            state: 'done',
            providerSession: undefined
          }
        ]
      ])
    }))
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
  })

  async function switchThenRestart(build: typeof realBuild = realBuild): Promise<void> {
    renderReadyPaneAccountRestarts(build)
    await act(async () => {
      expect(await switchAccount()).toBe('handled')
      await flush()
    })
  }

  it('restarts a pane no hook named on the session it looks up again at restart', async () => {
    await switchThenRestart()

    expect(handleRestartPane).toHaveBeenCalledTimes(1)
    expect(handleRestartPane.mock.calls[0][1].command).toContain(SESSION)
    expect(handleRestartPane.mock.calls[0][1].resumeProviderSession).toBeUndefined()
  })

  it('leaves the pane running, and says so, when the lookup then finds nothing', async () => {
    discoverClaudeSession.mockReset().mockResolvedValueOnce(record).mockResolvedValue(null)

    await switchThenRestart()

    expect(handleRestartPane).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })

  it('restarts on the session a hook names once one does, even when the lookup then finds nothing', async () => {
    discoverClaudeSession.mockReset().mockResolvedValueOnce(record).mockResolvedValue(null)
    expect(await switchAccount()).toBe('handled')

    await act(async () => {
      useAppStore.setState((state) => ({
        agentStatusByPaneKey: acceptedAgentStatuses([
          [
            PANE_KEY,
            {
              ...state.agentStatusByPaneKey.get(PANE_KEY)!,
              state: 'done',
              providerSession: { key: 'session_id', id: SESSION }
            }
          ]
        ])
      }))
      renderReadyPaneAccountRestarts(realBuild)
      await flush()
    })

    expect(handleRestartPane).toHaveBeenCalledTimes(1)
    expect(handleRestartPane.mock.calls[0][1].resumeProviderSession?.id).toBe(SESSION)
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('says a pane no hook named was not moved when its queued restart lost its record', async () => {
    renderReadyPaneAccountRestarts(realBuild)

    await act(async () => {
      useAppStore.getState().queuePaneAccountRestarts([OLD_PTY], 'claude')
      await flush()
    })

    expect(handleRestartPane).not.toHaveBeenCalled()
    expect(discoverClaudeSession).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
  })

  it.each([
    { setting: 'restart-all' as const, notices: 1 },
    { setting: 'restart' as const, notices: 0 }
  ])(
    'under $setting, gives $notices notice(s) when another pane holds a hook-named session at restart',
    async (row) => {
      const otherLeaf = '22222222-2222-4222-8222-222222222222'
      const named = {
        ...useAppStore.getState().agentStatusByPaneKey.get(PANE_KEY)!,
        providerSession: { key: 'session_id', id: SESSION } as const
      }
      useAppStore.setState((state) => ({
        tabsByWorktree: {
          wt1: [...state.tabsByWorktree.wt1, { ...state.tabsByWorktree.wt1[0], id: 'tab-2' }]
        },
        ptyIdsByTabId: { 'tab-1': [OLD_PTY], 'tab-2': ['pty-other'] },
        terminalLayoutsByTabId: {
          'tab-1': LAYOUT,
          'tab-2': { ...LAYOUT, ptyIdsByLeafId: { [otherLeaf]: 'pty-other' } }
        },
        agentStatusByPaneKey: acceptedAgentStatuses([
          [PANE_KEY, named],
          [`tab-2:${otherLeaf}`, { ...named, paneKey: `tab-2:${otherLeaf}`, tabId: 'tab-2' }]
        ])
      }))
      renderReadyPaneAccountRestarts(realBuild)

      await act(async () => {
        queueFromSwitch(row.setting)
        await flush()
      })

      expect(handleRestartPane).not.toHaveBeenCalled()
      expect(toast.warning).toHaveBeenCalledTimes(row.notices)
    }
  )

  it.each([
    { order: 'older first', putBack: [0, 1] },
    { order: 'newer first', putBack: [1, 0] }
  ])(
    'keeps the newer switch record when two taken restarts are put back, $order',
    ({ putBack }) => {
      const taken = ['session-older', 'session-newer'].map((id) => {
        recordQueuedClaudeRestarts(
          [OLD_PTY],
          false,
          new Map([[OLD_PTY, { key: 'session_id', id }]])
        )
        return takeQueuedClaudeRestart(OLD_PTY)
      })
      for (const index of putBack) {
        requeueRestart(OLD_PTY, 'claude', taken[index])
      }

      expect(takeQueuedClaudeRestart(OLD_PTY)?.session?.id).toBe('session-newer')
    }
  )

  it('says nothing for a pane whose agent was replaced by another before the restart ran', async () => {
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: acceptedAgentStatuses([
        [PANE_KEY, { ...state.agentStatusByPaneKey.get(PANE_KEY)!, agentType: 'codex' }]
      ])
    }))
    renderReadyPaneAccountRestarts(realBuild)

    await act(async () => {
      queueFromSwitch('restart-all')
      await flush()
    })

    expect(handleRestartPane).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('queues nothing again, and says so, for a pane that took another terminal during the lookup', async () => {
    discoverClaudeSession
      .mockReset()
      .mockResolvedValueOnce(record)
      .mockImplementationOnce(async () => {
        attachedPtyId = 'pty-new'
        useAppStore.setState({
          terminalLayoutsByTabId: { 'tab-1': { ...LAYOUT, ptyIdsByLeafId: { [LEAF]: 'pty-new' } } }
        })
        return record
      })

    await switchThenRestart()

    expect(handleRestartPane).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
  })

  it.each([
    {
      pane: 'took another terminal',
      move: () => {
        attachedPtyId = 'pty-new'
        useAppStore.getState().updateTabPtyId('tab-1', 'pty-new', OLD_PTY)
      },
      kept: false,
      restarts: 1
    },
    {
      pane: 'closed',
      move: () =>
        useAppStore.setState({
          terminalLayoutsByTabId: { 'tab-1': { ...LAYOUT, ptyIdsByLeafId: {} } }
        }),
      kept: false,
      restarts: 0
    },
    { pane: 'was unmounted', move: () => undefined, kept: true, restarts: 0 }
  ])(
    'puts the restart on the terminal a pane holds when it $pane after the lookup',
    async ({ move, kept, restarts }) => {
      let moved = false
      await switchThenRestart((...args) => {
        if (args[2] && !moved) {
          moved = true
          attachedPtyId = null
          move()
        }
        return realBuild(...args)
      })

      expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual(
        kept ? { [OLD_PTY]: 'claude' } : {}
      )
      expect(takeQueuedClaudeRestart(OLD_PTY) !== undefined).toBe(kept)
      expect(handleRestartPane).toHaveBeenCalledTimes(restarts)
    }
  )
})
