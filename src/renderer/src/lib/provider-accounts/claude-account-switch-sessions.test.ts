import { beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import {
  answerClaudeAccountSwitchPrompt,
  getClaudeAccountSwitchPrompt,
  handleRunningClaudeSessionsAfterSwitch,
  resetClaudeAccountSwitchSessionsForTests
} from './claude-account-switch-sessions'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type { ClaudeHostFolders } from '../agent-session/accounts/claude/claude-pane-account-folder'
import type * as paneSelectionLane from '../agent-session/accounts/codex-pane-selection-lane'
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
vi.mock('../../app-shell/platform/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'win32'
}))
vi.mock('@/runtime/hosts/preflight/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('../agent-session/accounts/codex-pane-selection-lane', async (importOriginal) => ({
  ...(await importOriginal<typeof paneSelectionLane>()),
  resolveCodexPaneSelectionLane: () => ({
    laneKey: 'host',
    source: 'derived',
    derivedLaneKey: null
  })
}))

const FOLDERS: Record<string, string> = {
  'acct-a': '/data/claude-accounts/acct-a',
  'acct-b': '/data/claude-accounts/acct-b',
  'acct-c': '/data/claude-accounts/acct-c'
}
const SYSTEM_HOME = '/home/dev/.claude'
const tabId = (n: number): string => `tab-${n}`
const leafId = (n: number): string => `0195f2ce-1111-4000-8000-00000000000${n}`
const ptyId = (n: number): string => `pty-${n}`

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
  systemDefaultHome: SYSTEM_HOME
}

const sessionId = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`
const recorded = (n: number, configDir: string) => ({
  key: 'session_id' as const,
  id: sessionId(n),
  transcriptPath: `${configDir}/projects/-r/${sessionId(n)}.jsonl`
})

function status(n: number, configDir: string | null): AgentStatusEntry {
  return {
    paneKey: makePaneKey(tabId(n), leafId(n)),
    tabId: tabId(n),
    state: 'done',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    ...(configDir ? { providerSession: recorded(n, configDir) } : {})
  }
}

function seed(
  policy: ClaudeAccountSwitchRunningSessions,
  panes: Record<number, string | null>
): void {
  const ns = Object.keys(panes).map(Number)
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/dev'),
      claudeAccountSwitchRunningSessions: policy,
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
      wt1: ns.map((n) => ({
        id: tabId(n),
        ptyId: ptyId(n),
        worktreeId: 'wt1',
        title: 'claude',
        customTitle: null,
        color: null,
        sortOrder: n,
        createdAt: n
      }))
    },
    ptyIdsByTabId: Object.fromEntries(ns.map((n) => [tabId(n), [ptyId(n)]])),
    terminalLayoutsByTabId: Object.fromEntries(
      ns.map((n) => [
        tabId(n),
        {
          root: { type: 'leaf', leafId: leafId(n) },
          activeLeafId: leafId(n),
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId(n)]: ptyId(n) }
        }
      ])
    ),
    agentStatusByPaneKey: acceptedAgentStatuses(
      ns.map((n) => [makePaneKey(tabId(n), leafId(n)), status(n, panes[n])])
    ),
    paneForegroundAgentByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingPaneAccountRestarts: {}
  })
}

const switchAccount = (from: string, to: string, madeElsewhere?: true) =>
  handleRunningClaudeSessionsAfterSwitch({
    owner: { kind: 'local' },
    target: { runtime: 'host' },
    before: { state: hostFolders, accountId: from },
    after: { state: hostFolders, accountId: to },
    madeElsewhere
  })

beforeEach(() => {
  vi.unstubAllGlobals()
  resetClaudeAccountSwitchSessionsForTests()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.warning).mockClear()
  vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
    foregroundProcess: 'claude',
    hasChildProcesses: true
  })
  vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('claude')
})

it('restarts sessions on every other account, never the one switched to', async () => {
  seed('restart-all', {
    1: FOLDERS['acct-a'],
    2: SYSTEM_HOME,
    3: FOLDERS['acct-c'],
    4: FOLDERS['acct-b']
  })

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({
    'pty-1': 'claude',
    'pty-2': 'claude',
    'pty-3': 'claude'
  })
})

it('restarts sessions elsewhere when none ran on the account left', async () => {
  seed('restart-all', { 2: SYSTEM_HOME, 3: FOLDERS['acct-c'], 4: FOLDERS['acct-b'] })

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({
    'pty-2': 'claude',
    'pty-3': 'claude'
  })
})

it('restarts only the account left when set to always restart', async () => {
  seed('restart', {
    1: FOLDERS['acct-a'],
    2: SYSTEM_HOME,
    3: FOLDERS['acct-c'],
    4: FOLDERS['acct-b']
  })

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'claude' })
})

it.each([
  {
    policy: 'restart-all' as const,
    toast: [
      expect.objectContaining({ description: 'accounts.claude.switchSessions.notMovedOther:2' })
    ]
  },
  { policy: 'restart' as const, toast: [] }
])(
  'counts sessions on other accounts whose process could not be read as not moved under restart-all only: $policy',
  async ({ policy, toast: description }) => {
    seed(policy, { 1: FOLDERS['acct-a'], 2: SYSTEM_HOME, 3: FOLDERS['acct-c'] })
    vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) => {
      if (id === ptyId(2)) {
        throw new Error('inspection failed')
      }
      return { foregroundProcess: id === ptyId(3) ? 'node' : 'claude', hasChildProcesses: true }
    })
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue(null)

    await switchAccount('acct-a', 'acct-b')

    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'claude' })
    expect(toast.success).toHaveBeenCalledWith(
      'accounts.claude.switchSessions.restartingOne',
      ...description
    )
  }
)

it.each(['restart-all', 'restart'] as const)(
  'queues the terminal a pane holds once the scan ends under %s',
  async (policy) => {
    seed(policy, { 1: FOLDERS['acct-a'] })
    vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) => {
      if (id === ptyId(1)) {
        useAppStore.getState().updateTabPtyId(tabId(1), 'pty-1b', ptyId(1))
      }
      return { foregroundProcess: 'claude', hasChildProcesses: true }
    })

    await switchAccount('acct-a', 'acct-b')

    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1b': 'claude' })
  }
)

it('queues a pane whose terminal was released during the scan under restart', async () => {
  seed('restart', { 1: FOLDERS['acct-a'], 2: FOLDERS['acct-a'] })
  vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) => {
    if (id === ptyId(2)) {
      useAppStore.getState().clearTabPtyId(tabId(2), ptyId(2))
    }
    return { foregroundProcess: 'claude', hasChildProcesses: true }
  })

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({
    'pty-1': 'claude',
    'pty-2': 'claude'
  })
  expect(toast.success).toHaveBeenCalledWith('accounts.claude.switchSessions.restartingOther:2')
})

it('skips a pane whose terminal was released during the scan under restart-all', async () => {
  seed('restart-all', { 1: FOLDERS['acct-a'], 2: FOLDERS['acct-a'] })
  vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) => {
    if (id === ptyId(2)) {
      useAppStore.getState().clearTabPtyId(tabId(2), ptyId(2))
    }
    return { foregroundProcess: 'claude', hasChildProcesses: true }
  })

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'claude' })
  expect(toast.success).toHaveBeenCalledWith('accounts.claude.switchSessions.restartingOne')
})

it('queues a pane whose terminal was released while the dialog was open', async () => {
  seed('ask', { 1: FOLDERS['acct-a'], 2: FOLDERS['acct-a'] })
  await switchAccount('acct-a', 'acct-b')

  useAppStore.getState().clearTabPtyId(tabId(2), ptyId(2))
  answerClaudeAccountSwitchPrompt('restart')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({
    'pty-1': 'claude',
    'pty-2': 'claude'
  })
  expect(toast.success).not.toHaveBeenCalled()
})

it.each(['restart-all', 'restart'] as const)(
  'announces no restart when every pane lost its terminal during the scan under %s',
  async (policy) => {
    seed(policy, { 1: FOLDERS['acct-a'] })
    vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async () => {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          [tabId(1)]: {
            root: { type: 'leaf', leafId: leafId(1) },
            activeLeafId: leafId(1),
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        }
      })
      return { foregroundProcess: 'claude', hasChildProcesses: true }
    })

    expect(await switchAccount('acct-a', 'acct-b')).toBe('show-confirmation')
    expect(toast.success).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  }
)

it('warns that a session stayed behind when nothing restarts under restart-all', async () => {
  seed('restart-all', { 3: FOLDERS['acct-c'] })
  vi.mocked(inspectRuntimeTerminalProcess).mockRejectedValue(new Error('inspection failed'))

  expect(await switchAccount('acct-a', 'acct-b')).toBe('show-confirmation')

  expect(toast.success).not.toHaveBeenCalled()
  expect(toast.warning).toHaveBeenCalledTimes(1)
  expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
})

it.each(['ask', 'restart'] as const)(
  'stays silent about a session left behind with nothing to restart under %s',
  async (policy) => {
    seed(policy, { 3: FOLDERS['acct-c'] })
    vi.mocked(inspectRuntimeTerminalProcess).mockRejectedValue(new Error('inspection failed'))

    expect(await switchAccount('acct-a', 'acct-b')).toBe('show-confirmation')

    expect(toast.warning).not.toHaveBeenCalled()
  }
)

it('names a session left behind in the restart toast when another one restarts', async () => {
  seed('restart-all', { 1: FOLDERS['acct-a'], 3: FOLDERS['acct-c'] })
  vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) => {
    if (id === ptyId(3)) {
      throw new Error('inspection failed')
    }
    return { foregroundProcess: 'claude', hasChildProcesses: true }
  })

  await switchAccount('acct-a', 'acct-b')

  expect(toast.success).toHaveBeenCalledWith('accounts.claude.switchSessions.restartingOne', {
    description: 'accounts.claude.switchSessions.notMovedOne'
  })
  expect(toast.warning).not.toHaveBeenCalled()
})

function discoverAt(configDir: string, during: () => void = () => {}): ReturnType<typeof vi.fn> {
  const discoverClaudeSession = vi.fn(async () => {
    during()
    return recorded(1, configDir)
  })
  vi.stubGlobal('window', { api: { pty: { discoverClaudeSession } } })
  return discoverClaudeSession
}

const paneSession = () =>
  useAppStore.getState().agentStatusByPaneKey.get(makePaneKey(tabId(1), leafId(1)))?.providerSession

it('queues a pane no hook named whose record sits on the account left under restart-all', async () => {
  seed('restart-all', { 1: null })
  discoverAt(FOLDERS['acct-a'])

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'claude' })
})

it('queues a pane no hook named whose record sits in System default under restart-all', async () => {
  seed('restart-all', { 1: null })
  discoverAt(SYSTEM_HOME)

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'claude' })
  expect(paneSession()).toBeUndefined()
})

it('queues a terminal that replaced the one looked up, to be checked again when it restarts', async () => {
  seed('restart-all', { 1: null, 2: null })
  const discoverClaudeSession = vi.fn(async (id: string) => {
    if (id === ptyId(1)) {
      useAppStore.getState().updateTabPtyId(tabId(1), 'pty-1b', ptyId(1))
    }
    return recorded(Number(id.slice(4)), FOLDERS['acct-a'])
  })
  vi.stubGlobal('window', { api: { pty: { discoverClaudeSession } } })

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({
    'pty-1b': 'claude',
    'pty-2': 'claude'
  })
  expect(toast.success).toHaveBeenCalledWith('accounts.claude.switchSessions.restartingOther:2')
})

it('keeps the session a hook reported while the lookup ran', async () => {
  seed('restart-all', { 1: null })
  const paneKey = makePaneKey(tabId(1), leafId(1))
  discoverAt(FOLDERS['acct-a'], () =>
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: acceptedAgentStatuses([
        [
          paneKey,
          {
            ...state.agentStatusByPaneKey.get(paneKey)!,
            providerSession: recorded(1, FOLDERS['acct-b'])
          }
        ]
      ])
    }))
  )

  await switchAccount('acct-a', 'acct-b')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  expect(paneSession()?.transcriptPath).toContain(FOLDERS['acct-b'])
})

it('looks every pane no hook named up again at each switch', async () => {
  seed('restart-all', { 1: null })
  discoverAt(FOLDERS['acct-a'])
  await switchAccount('acct-a', 'acct-b')
  useAppStore.setState({ pendingPaneAccountRestarts: {} })
  discoverAt(FOLDERS['acct-b'])

  await switchAccount('acct-b', 'acct-c')

  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ 'pty-1': 'claude' })
})

function stubLookups(lookUp: (id: string) => AgentProviderSessionMetadata | null) {
  const discoverClaudeSession = vi.fn(async (id: string) => lookUp(id))
  const recordBreadcrumb = vi.fn()
  vi.stubGlobal('window', {
    api: { pty: { discoverClaudeSession }, crashReports: { recordBreadcrumb } }
  })
  return { discoverClaudeSession, recordBreadcrumb }
}

function dropStatus(...ns: number[]): void {
  const dropped = new Set<string>(ns.map((n) => makePaneKey(tabId(n), leafId(n))))
  useAppStore.setState((state) => ({
    agentStatusByPaneKey: acceptedAgentStatuses(
      [...state.agentStatusByPaneKey].filter(([key]) => !dropped.has(key))
    )
  }))
}

const pending = () => useAppStore.getState().pendingPaneAccountRestarts

it('restarts neither of two panes without a status entry whose lookups find one conversation', async () => {
  seed('restart-all', { 1: null, 2: null })
  dropStatus(1, 2)
  stubLookups(() => recorded(1, FOLDERS['acct-a']))

  await switchAccount('acct-a', 'acct-b')

  expect(pending()).toEqual({})
  expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.sharedOther:2')
})

it('restarts neither a hook-named pane nor a looked-up pane holding its conversation', async () => {
  seed('restart-all', { 1: FOLDERS['acct-a'], 2: null })
  dropStatus(2)
  stubLookups((id) => (id === ptyId(2) ? recorded(1, FOLDERS['acct-a']) : null))

  await switchAccount('acct-a', 'acct-b')

  expect(pending()).toEqual({})
})

it.each(['looks', 'hook names'])(
  'cancels a looked-up restart, and says so, once a later switch %s its conversation in another pane',
  async (holder) => {
    seed('restart-all', { 1: null, 2: null })
    dropStatus(1, 2)
    stubLookups((id) => (id === ptyId(1) ? recorded(1, FOLDERS['acct-a']) : null))
    await switchAccount('acct-a', 'acct-b')
    expect(pending()).toEqual({ 'pty-1': 'claude' })
    stubLookups(() => recorded(1, FOLDERS['acct-a']))
    if (holder === 'hook names') {
      useAppStore.setState({
        agentStatusByPaneKey: acceptedAgentStatuses(
          Object.entries({
            [makePaneKey(tabId(2), leafId(2))]: {
              ...status(2, null),
              providerSession: recorded(1, FOLDERS['acct-a'])
            }
          })
        )
      })
    }

    await switchAccount('acct-b', 'acct-c')

    expect(pending()).toEqual({})
    expect(toast.warning).toHaveBeenCalledWith('accounts.claude.switchSessions.notMovedToOne')
  }
)

it.each(['keep', 'ask', 'restart'] as const)(
  'leaves a queued restart to its restart-time check when only hook-named panes share its conversation under %s',
  async (policy) => {
    seed(policy, { 1: FOLDERS['acct-a'], 2: FOLDERS['acct-a'] })
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: acceptedAgentStatuses([
        ...state.agentStatusByPaneKey,
        [
          makePaneKey(tabId(2), leafId(2)),
          { ...status(2, null), providerSession: recorded(1, FOLDERS['acct-a']) }
        ]
      ]),
      pendingPaneAccountRestarts: { [ptyId(1)]: 'claude' }
    }))

    await switchAccount('acct-b', 'acct-c')

    expect(pending()).toEqual({ 'pty-1': 'claude' })
  }
)

it('keeps the setting read when the switch began after it changes during the scan', async () => {
  seed('restart-all', { 1: FOLDERS['acct-a'], 3: FOLDERS['acct-c'] })
  vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async () => {
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, claudeAccountSwitchRunningSessions: 'restart' }
    }))
    return { foregroundProcess: 'claude', hasChildProcesses: true }
  })

  await switchAccount('acct-a', 'acct-b')

  expect(pending()).toEqual({ 'pty-1': 'claude', 'pty-3': 'claude' })
})

it('keeps the setting read when the switch began after it changes during a lookup', async () => {
  seed('restart-all', { 1: null })
  dropStatus(1)
  stubLookups(() => {
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, claudeAccountSwitchRunningSessions: 'restart' }
    }))
    return recorded(1, FOLDERS['acct-a'])
  })

  await switchAccount('acct-a', 'acct-b')

  expect(pending()).toEqual({ 'pty-1': 'claude' })
})

it.each(['ask', 'restart', 'keep'] as const)(
  'looks up no pane a hook left unnamed under %s',
  async (policy) => {
    seed(policy, { 1: null })
    const { discoverClaudeSession } = stubLookups(() => recorded(1, FOLDERS['acct-a']))

    await switchAccount('acct-a', 'acct-b')

    expect(discoverClaudeSession).not.toHaveBeenCalled()
    expect(pending()).toEqual({})
  }
)

it.each(['ask', 'restart', 'keep'] as const)(
  'neither looks up nor restarts a terminal without a status entry under %s',
  async (policy) => {
    seed(policy, { 1: null })
    dropStatus(1)
    const { discoverClaudeSession } = stubLookups(() => recorded(1, FOLDERS['acct-a']))

    vi.mocked(inspectRuntimeTerminalProcess).mockClear()

    await switchAccount('acct-a', 'acct-b')

    expect(discoverClaudeSession).not.toHaveBeenCalled()
    expect(inspectRuntimeTerminalProcess).not.toHaveBeenCalled()
    expect(pending()).toEqual({})
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
  }
)

it('counts a pane no lookup named as not moved under restart-all only when Claude is confirmed there', async () => {
  seed('restart-all', { 1: FOLDERS['acct-a'], 2: null, 3: null, 4: null })
  dropStatus(2, 3, 4)
  stubLookups(() => null)
  const foreground = (id: string) => (id === ptyId(3) ? 'pwsh' : id === ptyId(4) ? null : 'claude')
  vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) => ({
    foregroundProcess: id === ptyId(4) ? 'node' : foreground(id),
    hasChildProcesses: true
  }))
  vi.mocked(confirmRuntimeTerminalForegroundProcess).mockImplementation(async (id) =>
    foreground(id)
  )

  await switchAccount('acct-a', 'acct-b')

  expect(pending()).toEqual({ 'pty-1': 'claude' })
  expect(toast.success).toHaveBeenCalledWith(
    'accounts.claude.switchSessions.restartingOne',
    expect.objectContaining({ description: 'accounts.claude.switchSessions.notMovedOne' })
  )
})

it('names an unreadable terminal in the console without its worktree path', async () => {
  seed('restart', { 1: FOLDERS['acct-a'] })
  useAppStore.getState().updateTabPtyId(tabId(1), '/home/dev/repo@@a1b2c3d4', ptyId(1))
  vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
    foregroundProcess: 'node',
    hasChildProcesses: true
  })
  vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue(null)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  await switchAccount('acct-a', 'acct-b')

  expect(warn).toHaveBeenCalledWith('[claude-account-switch] could not read the foreground of', [
    '…@@a1b2c3d4'
  ])
  expect(JSON.stringify(warn.mock.calls)).not.toContain('/home/dev/repo')
  warn.mockRestore()
})

function bindRealPtyIds(...ns: number[]): void {
  for (const n of ns) {
    useAppStore.getState().updateTabPtyId(tabId(n), `wt1@@a000000${n}`, ptyId(n))
  }
}

const breadcrumbs = (recordBreadcrumb: ReturnType<typeof vi.fn>) =>
  recordBreadcrumb.mock.calls
    .map(([crumb]) => crumb)
    .filter((crumb) => crumb.name === 'claude_account_switch')

it('does not count a pane as not moved while an earlier restart-all still has its restart queued', async () => {
  seed('restart-all', { 1: null })
  dropStatus(1)
  stubLookups(() => recorded(1, FOLDERS['acct-a']))
  await switchAccount('acct-a', 'acct-b')
  expect(pending()).toEqual({ 'pty-1': 'claude' })
  stubLookups(() => null)
  vi.mocked(toast.warning).mockClear()

  await switchAccount('acct-b', 'acct-c')

  expect(pending()).toEqual({ 'pty-1': 'claude' })
  expect(toast.warning).not.toHaveBeenCalled()
})

it('records one breadcrumb per switch, listing panes until the detail is full', async () => {
  seed('restart-all', { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null })
  dropStatus(1, 2, 3, 4, 5, 6, 7)
  bindRealPtyIds(1, 2, 3, 4, 5, 6, 7)
  const { recordBreadcrumb } = stubLookups((id) =>
    id === 'wt1@@a0000001' ? recorded(1, FOLDERS['acct-a']) : null
  )
  const shell = (id: string) => (id === 'wt1@@a0000002' ? 'pwsh' : 'claude')
  vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) => ({
    foregroundProcess: shell(id),
    hasChildProcesses: true
  }))
  vi.mocked(confirmRuntimeTerminalForegroundProcess).mockImplementation(async (id) => shell(id))

  await switchAccount('acct-a', 'acct-b')

  expect(breadcrumbs(recordBreadcrumb)).toEqual([
    {
      name: 'claude_account_switch',
      data: {
        setting: 'restart-all',
        stage: 'scanned',
        result: 'handled',
        from: 'acct-a',
        to: 'acct-b',
        seen: 7,
        queued: 1,
        notMoved: 'not-running=1,no-session=5',
        panes:
          'a0000001 lookup queued on-account, a0000002 none kept not-running, a0000003 none kept no-session, a0000004 none kept no-session, a0000005 none kept no-session, a0000006 none kept no-session (+1 more)'
      }
    }
  ])
})

it('records a pane the ask setting offers as asked, with nothing queued', async () => {
  seed('ask', { 1: FOLDERS['acct-a'] })
  bindRealPtyIds(1)
  const { recordBreadcrumb } = stubLookups(() => null)

  await switchAccount('acct-a', 'acct-b')

  expect(breadcrumbs(recordBreadcrumb)).toEqual([
    {
      name: 'claude_account_switch',
      data: {
        setting: 'ask',
        stage: 'scanned',
        result: 'handled',
        from: 'acct-a',
        to: 'acct-b',
        seen: 1,
        queued: 0,
        notMoved: '',
        panes: 'a0000001 hook asked on-account'
      }
    }
  ])
})

it('records that a switch came from a phone or the CLI, where ask restarts unprompted', async () => {
  seed('ask', { 1: FOLDERS['acct-a'] })
  bindRealPtyIds(1)
  const { recordBreadcrumb } = stubLookups(() => null)

  await switchAccount('acct-a', 'acct-b', true)

  expect(getClaudeAccountSwitchPrompt()).toBeNull()
  expect(breadcrumbs(recordBreadcrumb)).toEqual([
    {
      name: 'claude_account_switch',
      data: {
        setting: 'restart',
        madeElsewhere: true,
        stage: 'scanned',
        result: 'handled',
        from: 'acct-a',
        to: 'acct-b',
        seen: 1,
        queued: 1,
        notMoved: '',
        panes: 'a0000001 hook queued on-account'
      }
    }
  ])
})

it('records a switch to the account already selected', async () => {
  seed('restart-all', { 1: FOLDERS['acct-a'] })
  const { recordBreadcrumb } = stubLookups(() => null)

  await switchAccount('acct-a', 'acct-a')

  expect(breadcrumbs(recordBreadcrumb)).toEqual([
    {
      name: 'claude_account_switch',
      data: {
        setting: 'restart-all',
        stage: 'same-account',
        result: 'show-confirmation',
        from: 'acct-a',
        to: 'acct-a',
        seen: 0,
        queued: 0,
        notMoved: '',
        panes: ''
      }
    }
  ])
})
