import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { provideLayoutFrameTerminalPanes } from '@/runtime/workspace-layout/frames/layout-frame-terminal-panes'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import {
  answerClaudeAccountSwitchPrompt,
  handleRunningClaudeSessionsAfterSwitch,
  resetClaudeAccountSwitchSessionsForTests
} from '@/lib/provider-accounts/claude-account-switch-sessions'
import { buildPaneAccountRestartStartup } from '@/lib/agent-session/accounts/agent-account-restart-startup'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { AGENT_SESSION_ACCOUNT_SWITCH_TERMINAL_CONTINUATION_MESSAGE as FOLLOW_UP } from '../../../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import { ptyDataHandlers } from '../../pty-transport/shutdown/pty-shutdown-data-suspension'
import { lookUpDiscoveredClaudeRestart } from '../discovered-claude-restart'
import {
  recordQueuedClaudeRestarts,
  takeQueuedClaudeRestart
} from '@/lib/agent-session/accounts/claude/claude-queued-restart-records'
import {
  installCodexDetachedPaneRestartExecutor,
  resetCodexDetachedPaneRestartExecutorForTests
} from './codex-detached-pane-restart-scheduler'
import type { ClaudeHostFolders } from '@/lib/agent-session/accounts/claude/claude-pane-account-folder'
import type { AgentProviderSessionMetadata } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type * as paneSelectionLane from '@/lib/agent-session/accounts/codex-pane-selection-lane'
import type * as sonner from 'sonner'

vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof sonner>()),
  toast: { success: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  translate: (key: string, _fallback: string, values?: { count?: number }) =>
    values?.count === undefined ? key : `${key}:${values.count}`
}))
vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))
vi.mock('@/app-shell/platform/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'win32'
}))
vi.mock('@/lib/agent-session/accounts/codex-pane-selection-lane', async (importOriginal) => ({
  ...(await importOriginal<typeof paneSelectionLane>()),
  resolveCodexPaneSelectionLane: () => ({
    laneKey: 'host',
    source: 'derived',
    derivedLaneKey: null
  })
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'
const SESSION_ID = '00000000-0000-4000-8000-0000000000a1'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const FOLDERS: Record<string, string> = {
  'acct-a': '/data/claude-accounts/acct-a',
  'acct-b': '/data/claude-accounts/acct-b',
  'acct-c': '/data/claude-accounts/acct-c'
}
const hostFolders: ClaudeHostFolders = {
  accounts: Object.entries(FOLDERS).map(([id, home]) => ({
    id,
    email: `${id}@example.com`,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    home
  })),
  systemDefaultHome: '/home/dev/.claude'
}

function seedRestartAllPaneOnFirstAccount(): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/dev'),
      claudeAccountSwitchRunningSessions: 'restart-all',
      claudeManagedAccounts: Object.entries(FOLDERS).map(([id, managedAuthPath]) => ({
        id,
        email: `${id}@example.com`,
        managedAuthPath,
        authMethod: 'subscription-oauth',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
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
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: OLD_PTY }
      }
    },
    agentStatusByPaneKey: acceptedAgentStatuses(
      Object.entries({
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          state: 'done',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          agentType: 'claude',
          providerSession: {
            key: 'session_id',
            id: SESSION_ID,
            transcriptPath: `${FOLDERS['acct-a']}/projects/-r/${SESSION_ID}.jsonl`
          }
        }
      })
    ),
    paneForegroundAgentByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingPaneAccountRestarts: {}
  })
}

const switchAccount = (from: string, to: string) =>
  handleRunningClaudeSessionsAfterSwitch({
    owner: { kind: 'local' },
    target: { runtime: 'host' },
    before: { state: hostFolders, accountId: from },
    after: { state: hostFolders, accountId: to }
  })

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const originalWindow = (globalThis as { window?: typeof window }).window
const spawn = vi.fn()
const discoverClaudeSession = vi.fn()
let framePtyId = OLD_PTY

beforeEach(() => {
  resetCodexDetachedPaneRestartExecutorForTests()
  resetClaudeAccountSwitchSessionsForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.warning).mockClear()
  framePtyId = OLD_PTY
  discoverClaudeSession.mockReset().mockResolvedValue(null)
  vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
    foregroundProcess: 'claude',
    hasChildProcesses: true
  })
  vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('claude')
  provideLayoutFrameTerminalPanes({
    holdsTerminalPane: () => false,
    terminalTab: (worktreeId, tabId) =>
      worktreeId === 'wt1' && tabId === 'tab-1'
        ? {
            id: 'tab-1',
            kind: 'terminal',
            entityId: 'tab-1',
            executionHostId: 'local',
            createdAt: 1,
            customTitle: null,
            color: null,
            terminal: {
              root: { type: 'leaf', leafId: LEAF_ID },
              panes: [{ leafId: LEAF_ID, ptyId: framePtyId }]
            }
          }
        : undefined
  })
  spawn.mockReset()
  vi.stubGlobal('window', {
    ...originalWindow,
    api: {
      ...originalWindow?.api,
      pty: {
        ...originalWindow?.api?.pty,
        spawn,
        kill: vi.fn().mockResolvedValue(undefined),
        discoverClaudeSession
      }
    }
  })
})

afterEach(() => {
  resetCodexDetachedPaneRestartExecutorForTests()
  ptyDataHandlers.delete(OLD_PTY)
  vi.unstubAllGlobals()
})

it('restarts a session on the next switch after its restart-all spawns were rejected', async () => {
  spawn.mockRejectedValue(new Error('launch refused'))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const uninstall = installCodexDetachedPaneRestartExecutor()
  try {
    seedRestartAllPaneOnFirstAccount()
    await switchAccount('acct-a', 'acct-b')
    await settle()
    await settle()
    expect(spawn).toHaveBeenCalledTimes(3)

    spawn.mockReset().mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-b', 'acct-a')
    await settle()
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})

    vi.mocked(toast.success).mockClear()
    expect(await switchAccount('acct-a', 'acct-b')).toBe('handled')
    await settle()

    expect(toast.success).toHaveBeenCalledWith('accounts.claude.switchSessions.restartingOne')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  } finally {
    uninstall()
    warn.mockRestore()
  }
})

const recordIn = (folder: string) => ({
  key: 'session_id' as const,
  id: SESSION_ID,
  transcriptPath: `${folder}/projects/-r/${SESSION_ID}.jsonl`
})

function seedHooklessPane(policy: 'ask' | 'restart' | 'restart-all' = 'restart-all'): void {
  seedRestartAllPaneOnFirstAccount()
  useAppStore.setState((current) => ({
    settings: { ...current.settings!, claudeAccountSwitchRunningSessions: policy },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [PANE_KEY, { ...current.agentStatusByPaneKey.get(PANE_KEY)!, providerSession: undefined }]
    ])
  }))
}

function rebindPaneTo(ptyId: string, providerSession?: AgentProviderSessionMetadata): void {
  framePtyId = ptyId
  useAppStore.setState((current) => ({
    tabsByWorktree: { wt1: [{ ...current.tabsByWorktree.wt1[0], ptyId }] },
    ptyIdsByTabId: { 'tab-1': [ptyId] },
    terminalLayoutsByTabId: {
      'tab-1': { ...current.terminalLayoutsByTabId['tab-1'], ptyIdsByLeafId: { [LEAF_ID]: ptyId } }
    },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [PANE_KEY, { ...current.agentStatusByPaneKey.get(PANE_KEY)!, state: 'done', providerSession }]
    ]),
    pendingPaneAccountRestarts: {}
  }))
}

async function withExecutor(run: () => Promise<void>): Promise<void> {
  const uninstall = installCodexDetachedPaneRestartExecutor()
  try {
    await run()
  } finally {
    uninstall()
  }
}

const spawnedCommand = (call = 0): string => spawn.mock.calls[call]?.[0]?.command ?? ''

it('moves a pane no hook named again at the switch after its restart', () =>
  withExecutor(async () => {
    seedHooklessPane()
    discoverClaudeSession.mockResolvedValue(recordIn(FOLDERS['acct-a']))
    spawn.mockResolvedValueOnce({ id: NEW_PTY }).mockResolvedValue({ id: 'wt1@@third' })
    await switchAccount('acct-a', 'acct-b')
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawnedCommand().match(/--resume/g)).toEqual(['--resume'])

    rebindPaneTo(NEW_PTY, spawn.mock.calls[0][0].resumeProviderSession)
    discoverClaudeSession.mockResolvedValue(recordIn(FOLDERS['acct-b']))
    await switchAccount('acct-b', 'acct-a')
    await settle()

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1][0].replacesPtyId).toBe(NEW_PTY)
  }))

it('leaves a pane no hook named running, and says so, when its session is gone at restart', () =>
  withExecutor(async () => {
    seedHooklessPane()
    discoverClaudeSession.mockResolvedValueOnce(recordIn(FOLDERS['acct-a'])).mockResolvedValue(null)
    expect(await switchAccount('acct-a', 'acct-b')).toBe('handled')
    await settle()

    expect(toast.success).toHaveBeenCalledWith('accounts.claude.switchSessions.restartingOne')
    expect(spawn).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      OLD_PTY
    )
  }))

it('restarts a pane picked after a later turn, on the session it looks up then', () =>
  withExecutor(async () => {
    seedHooklessPane('ask')
    discoverClaudeSession.mockResolvedValue(recordIn(FOLDERS['acct-a']))
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    const store = useAppStore.getState()
    store.setAgentStatus(PANE_KEY, { state: 'working', prompt: 'next', agentType: 'claude' })
    store.setAgentStatus(PANE_KEY, { state: 'done', prompt: 'next', agentType: 'claude' })
    answerClaudeAccountSwitchPrompt('restart')
    await settle()

    expect(spawnedCommand().match(/--resume/g)).toEqual(['--resume'])
    expect(spawnedCommand()).toContain(SESSION_ID)
  }))

it('names each launch flag once when the command override already sets the model', () =>
  withExecutor(async () => {
    seedHooklessPane()
    useAppStore.setState((current) => ({
      settings: {
        ...current.settings!,
        agentCmdOverrides: { claude: 'claude --model lane-model-1' }
      }
    }))
    discoverClaudeSession.mockResolvedValue({
      ...recordIn(FOLDERS['acct-a']),
      model: 'lane-model-7',
      effort: 'high',
      permissionMode: 'bypassPermissions'
    })
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    await settle()

    const command = spawnedCommand()
    expect(command.match(/--model/g)).toEqual(['--model'])
    expect(command).toContain('lane-model-1')
    expect(command.match(/--effort/g)).toEqual(['--effort'])
    expect(command.match(/--dangerously-skip-permissions/g)).toHaveLength(1)
  }))

const lookedUpAtA = () => discoverClaudeSession.mockResolvedValue(recordIn(FOLDERS['acct-a']))
const leafPtyId = () =>
  useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]

const followUps = (call = 0): number => spawnedCommand(call).split(FOLLOW_UP).length - 1

it('retries a rejected spawn on the session and flags found before main stopped the old terminal, with one follow-up per spawn', () =>
  withExecutor(async () => {
    seedHooklessPane()
    const found = { ...recordIn(FOLDERS['acct-a']), effort: 'high' }
    discoverClaudeSession
      .mockResolvedValueOnce(recordIn(FOLDERS['acct-a']))
      .mockResolvedValueOnce(found)
      .mockResolvedValue(null)
    spawn.mockRejectedValueOnce(new Error('launch refused')).mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    await settle()

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawnedCommand(1)).toBe(spawnedCommand(0))
    expect(spawnedCommand(1)).toContain('--effort')
    expect(spawnedCommand(1)).toContain(SESSION_ID)
    expect([followUps(0), followUps(1)]).toEqual([1, 1])
    expect(leafPtyId()).toBe(NEW_PTY)
  }))

it('says a pane no hook named was not moved once its restart-all spawns are spent', () =>
  withExecutor(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedHooklessPane()
    lookedUpAtA()
    spawn.mockRejectedValue(new Error('launch refused'))
    await switchAccount('acct-a', 'acct-b')
    await settle()
    await settle()
    warn.mockRestore()

    expect(spawn).toHaveBeenCalledTimes(3)
    expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
    expect(leafPtyId()).toBe(OLD_PTY)
  }))

it.each(['restart-all', 'restart', 'ask'] as const)(
  'hands a pane no hook named to the tab opened during its lookup under %s',
  (policy) =>
    withExecutor(async () => {
      seedHooklessPane(policy)
      lookedUpAtA()
        .mockResolvedValueOnce(recordIn(FOLDERS['acct-a']))
        .mockImplementationOnce(async () => {
          ptyDataHandlers.set(OLD_PTY, () => {})
          return recordIn(FOLDERS['acct-a'])
        })
      await switchAccount('acct-a', 'acct-b')
      answerClaudeAccountSwitchPrompt('restart')
      await settle()
      expect(spawn).not.toHaveBeenCalled()
      expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ [OLD_PTY]: 'claude' })

      const pane = { worktreeId: 'wt1', tabId: 'tab-1', leafId: LEAF_ID }
      const onScreen = await lookUpDiscoveredClaudeRestart(
        'claude',
        { ptyId: OLD_PTY, ...pane },
        takeQueuedClaudeRestart(OLD_PTY),
        (session) => buildPaneAccountRestartStartup('claude', pane, session)
      )
      expect(onScreen?.command).toContain(SESSION_ID)
    })
)

it('names the effort once when the recorded launch command already sets it', () =>
  withExecutor(async () => {
    seedHooklessPane()
    useAppStore.setState({
      getAgentLaunchConfigForStatusEntry: () => ({
        agentCommand: 'claude --effort high',
        agentArgs: '',
        agentEnv: {}
      })
    })
    discoverClaudeSession.mockResolvedValue({ ...recordIn(FOLDERS['acct-a']), effort: 'high' })
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    await settle()

    expect(spawnedCommand().match(/--effort/g)).toEqual(['--effort'])
    expect(spawnedCommand()).toContain(SESSION_ID)
  }))

it('restarts a queued pane no hook named after a later switch could not look it up', async () => {
  seedHooklessPane()
  lookedUpAtA().mockResolvedValueOnce(recordIn(FOLDERS['acct-a'])).mockResolvedValueOnce(null)
  spawn.mockResolvedValue({ id: NEW_PTY })
  await switchAccount('acct-a', 'acct-b')
  await switchAccount('acct-b', 'acct-c')
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ [OLD_PTY]: 'claude' })

  await withExecutor(settle)

  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawnedCommand()).toContain(SESSION_ID)
})

it('waits out a turn that starts while it looks a pane no hook named up at restart', () =>
  withExecutor(async () => {
    seedHooklessPane('ask')
    const turn = (state: 'working' | 'done') =>
      useAppStore
        .getState()
        .setAgentStatus(PANE_KEY, { state, prompt: 'next', agentType: 'claude' })
    lookedUpAtA()
      .mockResolvedValueOnce(recordIn(FOLDERS['acct-a']))
      .mockImplementationOnce(async () => {
        turn('working')
        return recordIn(FOLDERS['acct-a'])
      })
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    answerClaudeAccountSwitchPrompt('restart')
    await settle()
    expect(spawn).not.toHaveBeenCalled()

    turn('done')
    await settle()

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawnedCommand()).toContain(SESSION_ID)
  }))

const OTHER_SESSION_ID = '00000000-0000-4000-8000-0000000000b2'
const SECOND_LEAF = '22222222-2222-4222-8222-222222222222'
const SECOND_PTY = 'wt1@@second'
const pending = () => useAppStore.getState().pendingPaneAccountRestarts
const dropStatus = () => useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses() })

const setPolicy = (policy: 'ask' | 'restart' | 'restart-all' | 'keep') =>
  useAppStore.setState((current) => ({
    settings: { ...current.settings!, claudeAccountSwitchRunningSessions: policy }
  }))

const setTurn = (state: 'working' | 'done') =>
  useAppStore.setState((current) => ({
    agentStatusByPaneKey: acceptedAgentStatuses([
      ...current.agentStatusByPaneKey,
      [PANE_KEY, { ...current.agentStatusByPaneKey.get(PANE_KEY)!, state }]
    ])
  }))

function sleepOn(id: string): void {
  useAppStore.setState({
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'wt1',
        agent: 'claude',
        providerSession: { ...recordIn(FOLDERS['acct-a']), id },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1
      }
    }
  })
}

function addSecondPane(): void {
  useAppStore.setState((current) => ({
    tabsByWorktree: {
      wt1: [
        ...current.tabsByWorktree.wt1,
        { ...current.tabsByWorktree.wt1[0], id: 'tab-2', ptyId: SECOND_PTY }
      ]
    },
    ptyIdsByTabId: { ...current.ptyIdsByTabId, 'tab-2': [SECOND_PTY] },
    terminalLayoutsByTabId: {
      ...current.terminalLayoutsByTabId,
      'tab-2': {
        root: { type: 'leaf', leafId: SECOND_LEAF },
        activeLeafId: SECOND_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SECOND_LEAF]: SECOND_PTY }
      }
    }
  }))
}

it('moves a Claude pane with no status entry and asks it once to continue, as after a cold start', () =>
  withExecutor(async () => {
    seedRestartAllPaneOnFirstAccount()
    dropStatus()
    lookedUpAtA()
    spawn.mockResolvedValue({ id: NEW_PTY })
    expect(await switchAccount('acct-a', 'acct-b')).toBe('handled')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))

    const command = spawnedCommand()
    expect(command.match(/--resume/g)).toEqual(['--resume'])
    expect(followUps()).toBe(1)
    expect(command.indexOf(FOLLOW_UP)).toBeGreaterThan(command.indexOf(SESSION_ID))
  }))

it('asks a hook-named pane once to continue after its restart-all resume', () =>
  withExecutor(async () => {
    seedRestartAllPaneOnFirstAccount()
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))

    expect(followUps()).toBe(1)
  }))

it('keeps the turn hold and sends no follow-up for a restart queued under restart after the setting changes', () =>
  withExecutor(async () => {
    seedRestartAllPaneOnFirstAccount()
    setPolicy('restart')
    setTurn('working')
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    setPolicy('restart-all')
    setTurn('working')
    await settle()
    expect(spawn).not.toHaveBeenCalled()

    setTurn('done')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    expect(followUps()).toBe(0)
  }))

it('drops a queued restart, and says so, once its pane runs another conversation', () =>
  withExecutor(async () => {
    seedHooklessPane()
    discoverClaudeSession
      .mockResolvedValueOnce(recordIn(FOLDERS['acct-a']))
      .mockResolvedValue({ ...recordIn(FOLDERS['acct-a']), id: OTHER_SESSION_ID })
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    await vi.waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(pending()).toEqual({})
  }))

it('moves a pane that has only a sleeping record on the session its lookup finds', () =>
  withExecutor(async () => {
    seedRestartAllPaneOnFirstAccount()
    dropStatus()
    sleepOn(OTHER_SESSION_ID)
    lookedUpAtA()
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))

    expect(spawnedCommand()).toContain(SESSION_ID)
    expect(spawnedCommand()).not.toContain(OTHER_SESSION_ID)
  }))

it('counts a pane that has only a sleeping record as not moved when its lookup finds nothing', () =>
  withExecutor(async () => {
    seedRestartAllPaneOnFirstAccount()
    dropStatus()
    sleepOn(SESSION_ID)

    expect(await switchAccount('acct-a', 'acct-b')).toBe('show-confirmation')

    expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
    expect(pending()).toEqual({})
  }))

it.each([
  { other: 'on the terminal it was looked up on', rebound: false },
  { other: 'rebound to another terminal since', rebound: true }
])(
  'skips a queued restart once a lookup finds its conversation open in another pane $other',
  ({ rebound }) =>
    withExecutor(async () => {
      seedRestartAllPaneOnFirstAccount()
      setPolicy('restart')
      setTurn('working')
      addSecondPane()
      discoverClaudeSession.mockImplementation(async (id: string) =>
        id === SECOND_PTY ? recordIn(FOLDERS['acct-a']) : null
      )
      spawn.mockResolvedValue({ id: NEW_PTY })
      await switchAccount('acct-a', 'acct-b')
      setPolicy('restart-all')
      await switchAccount('acct-b', 'acct-c')
      if (rebound) {
        useAppStore.getState().updateTabPtyId('tab-2', 'wt1@@second-rot', SECOND_PTY)
      }
      setTurn('done')
      await vi.waitFor(() => expect(pending()).toEqual({}))

      expect(spawn).not.toHaveBeenCalled()
      expect(toast.warning).not.toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
    })
)

const ROTATED_PTY = 'wt1@@rot'
const rotateTerminal = (): void => {
  framePtyId = ROTATED_PTY
  useAppStore.getState().updateTabPtyId('tab-1', ROTATED_PTY, OLD_PTY)
}

it('skips the turn hold, retries and asks to continue for a hook-named pane rebound before its restart-all restart', async () => {
  seedRestartAllPaneOnFirstAccount()
  setTurn('working')
  spawn.mockRejectedValueOnce(new Error('launch refused')).mockResolvedValue({ id: NEW_PTY })
  await switchAccount('acct-a', 'acct-b')
  rotateTerminal()
  expect(pending()).toEqual({ [ROTATED_PTY]: 'claude' })

  await withExecutor(settle)

  expect(spawn).toHaveBeenCalledTimes(2)
  expect(spawn.mock.calls[1][0].replacesPtyId).toBe(ROTATED_PTY)
  expect([followUps(0), followUps(1)]).toEqual([1, 1])
})

it('moves a pane with no status entry rebound before its restart-all restart', async () => {
  seedRestartAllPaneOnFirstAccount()
  dropStatus()
  lookedUpAtA()
  spawn.mockResolvedValue({ id: NEW_PTY })
  await switchAccount('acct-a', 'acct-b')
  rotateTerminal()

  await withExecutor(settle)

  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawnedCommand()).toContain(SESSION_ID)
  expect(discoverClaudeSession).toHaveBeenLastCalledWith(ROTATED_PTY)
})

it.each([
  {
    step: 'inspects it',
    rebind: () =>
      vi.mocked(inspectRuntimeTerminalProcess).mockImplementationOnce(async () => {
        rotateTerminal()
        return { foregroundProcess: 'claude', hasChildProcesses: true }
      })
  },
  {
    step: 'looks it up',
    rebind: () =>
      discoverClaudeSession.mockImplementationOnce(async () => {
        rotateTerminal()
        return recordIn(FOLDERS['acct-a'])
      })
  }
])('moves a pane with no status entry rebound while the switch $step', async ({ rebind }) => {
  seedRestartAllPaneOnFirstAccount()
  dropStatus()
  lookedUpAtA()
  rebind()
  spawn.mockResolvedValue({ id: NEW_PTY })
  await switchAccount('acct-a', 'acct-b')
  expect(pending()).toEqual({ [ROTATED_PTY]: 'claude' })

  await withExecutor(settle)

  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawnedCommand()).toContain(SESSION_ID)
  expect(discoverClaudeSession).toHaveBeenLastCalledWith(ROTATED_PTY)
})

it.each([
  { pane: 'no status entry', seed: dropStatus },
  {
    pane: 'only a sleeping record',
    seed: () => {
      dropStatus()
      sleepOn(OTHER_SESSION_ID)
    }
  },
  { pane: 'a status entry no hook named', seed: () => seedHooklessPane() }
])(
  'says a pane with $pane was not moved when its queued restart lost its record',
  async ({ seed }) => {
    seedRestartAllPaneOnFirstAccount()
    seed()
    lookedUpAtA()
    spawn.mockResolvedValue({ id: NEW_PTY })
    await switchAccount('acct-a', 'acct-b')
    expect(pending()).toEqual({ [OLD_PTY]: 'claude' })
    expect(toast.warning).not.toHaveBeenCalled()
    takeQueuedClaudeRestart(OLD_PTY)

    await withExecutor(settle)

    expect(spawn).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
  }
)

it.each([
  ['ask', 'acct-a'],
  ['ask', 'acct-c'],
  ['restart', 'acct-a'],
  ['restart', 'acct-c'],
  ['keep', 'acct-a'],
  ['keep', 'acct-c']
] as const)(
  'cancels a restart-all restart of a pane with no status entry when a switch under %s goes to %s',
  async (policy, to) => {
    seedRestartAllPaneOnFirstAccount()
    dropStatus()
    lookedUpAtA()
    await switchAccount('acct-a', 'acct-b')
    expect(pending()).toEqual({ [OLD_PTY]: 'claude' })
    setPolicy(policy)
    discoverClaudeSession.mockClear()

    await switchAccount('acct-b', to)
    expect(pending()).toEqual({})
    expect(discoverClaudeSession).not.toHaveBeenCalled()

    await withExecutor(settle)

    expect(toast.warning).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  }
)

it('keeps a restart-all restart of a pane no hook named that has a status entry across a switch under ask', async () => {
  seedHooklessPane()
  lookedUpAtA()
  await switchAccount('acct-a', 'acct-b')
  setPolicy('ask')

  await switchAccount('acct-b', 'acct-c')

  expect(pending()).toEqual({ [OLD_PTY]: 'claude' })
})

it('says a pane with no status entry was not moved when its record was lost before a switch under ask', async () => {
  seedRestartAllPaneOnFirstAccount()
  dropStatus()
  lookedUpAtA()
  await switchAccount('acct-a', 'acct-b')
  takeQueuedClaudeRestart(OLD_PTY)
  setPolicy('ask')
  await switchAccount('acct-b', 'acct-c')

  await withExecutor(settle)

  expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
})

it('restarts a hook-named pane on its own session when its queued restart lost its record', async () => {
  seedRestartAllPaneOnFirstAccount()
  spawn.mockResolvedValue({ id: NEW_PTY })
  await switchAccount('acct-a', 'acct-b')
  takeQueuedClaudeRestart(OLD_PTY)

  await withExecutor(settle)

  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawnedCommand()).toContain(SESSION_ID)
  expect(toast.warning).not.toHaveBeenCalled()
})

it('says a pane was not moved when its terminal is rebound onto one an older record names', async () => {
  seedRestartAllPaneOnFirstAccount()
  dropStatus()
  lookedUpAtA()
  await switchAccount('acct-a', 'acct-b')
  recordQueuedClaudeRestarts([ROTATED_PTY], true)
  takeQueuedClaudeRestart(OLD_PTY)
  rotateTerminal()

  await withExecutor(settle)

  expect(spawn).not.toHaveBeenCalled()
  expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
})

it('restarts a hook-named pane on its own session after it is rebound onto the looked-up terminal of a closed pane', async () => {
  seedRestartAllPaneOnFirstAccount()
  setPolicy('ask')
  addSecondPane()
  const secondStatus = { state: 'done', prompt: '', agentType: 'claude' } as const
  useAppStore.getState().setAgentStatus(makePaneKey('tab-2', SECOND_LEAF), secondStatus)
  discoverClaudeSession.mockImplementation(async (id: string) =>
    id === SECOND_PTY ? { ...recordIn(FOLDERS['acct-a']), id: OTHER_SESSION_ID } : null
  )
  spawn.mockResolvedValue({ id: NEW_PTY })
  await switchAccount('acct-a', 'acct-b')
  useAppStore.setState((current) => ({
    tabsByWorktree: { wt1: [current.tabsByWorktree.wt1[0]] },
    ptyIdsByTabId: { 'tab-1': current.ptyIdsByTabId['tab-1'] },
    terminalLayoutsByTabId: { 'tab-1': current.terminalLayoutsByTabId['tab-1'] },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [PANE_KEY, current.agentStatusByPaneKey.get(PANE_KEY)!]
    ])
  }))
  framePtyId = SECOND_PTY
  useAppStore.getState().updateTabPtyId('tab-1', SECOND_PTY, OLD_PTY)
  discoverClaudeSession.mockResolvedValue(recordIn(FOLDERS['acct-a']))
  answerClaudeAccountSwitchPrompt('restart', { ptyIds: [OLD_PTY] })

  await withExecutor(settle)

  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawnedCommand()).toContain(SESSION_ID)
  expect(toast.warning).not.toHaveBeenCalled()
})

it('restarts on the session a hook names once one does, even when the restart-time lookup finds nothing', async () => {
  seedHooklessPane()
  lookedUpAtA()
  spawn.mockResolvedValue({ id: NEW_PTY })
  await switchAccount('acct-a', 'acct-b')
  useAppStore.setState(({ agentStatusByPaneKey: statuses }) => ({
    agentStatusByPaneKey: acceptedAgentStatuses([
      [PANE_KEY, { ...statuses.get(PANE_KEY)!, providerSession: recordIn(FOLDERS['acct-a']) }]
    ])
  }))
  discoverClaudeSession.mockResolvedValue(null)

  await withExecutor(settle)

  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawnedCommand()).toContain(SESSION_ID)
  expect(toast.warning).not.toHaveBeenCalled()
})
