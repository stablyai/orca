import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../../../shared/constants'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { findClaudeSwitchSessions } from './claude-session-account-move'
import type { ClaudePaneLookups } from './claude-queued-restart-records'
import {
  findQueuedClaudeRestartsOnAccount,
  settleQueuedClaudeRestarts
} from './claude-pane-session-lookup'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { ClaudeManagedAccount } from '../../../../../../shared/agent-accounts/managed-account-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../../../shared/execution-host/project-execution-runtime'
import type * as localPreflightContext from '@/runtime/hosts/preflight/local-preflight-context'
import type * as paneSelectionLane from '../codex-pane-selection-lane'
import type { ClaudeHostFolders } from './claude-pane-account-folder'

const laneByPtyId: Record<string, string> = {}
let projectRuntime: ProjectExecutionRuntimeResolution | undefined

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))
vi.mock('../../../../app-shell/platform/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'win32'
}))
vi.mock('@/runtime/hosts/preflight/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => projectRuntime
}))
vi.mock('../codex-pane-selection-lane', async (importOriginal) => ({
  ...(await importOriginal<typeof paneSelectionLane>()),
  resolveCodexPaneSelectionLane: ({ ptyId }: { ptyId: string }) => ({
    laneKey: laneByPtyId[ptyId] ?? 'host',
    source: 'derived',
    derivedLaneKey: null
  })
}))

const LOCAL = { kind: 'local' } as const
const HOST = { runtime: 'host' } as const
const SESSION_ID = '00000000-0000-4000-8000-0000000000a1'
const FOLDER_A = '/data/claude-accounts/acct-a'
const FOLDER_B = '/data/claude-accounts/acct-b'

function account(id: string, managedAuthPath: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

type SeededPane = {
  n: number
  agentType?: 'claude' | 'codex'
  state?: AgentStatusEntry['state']
  sessionId?: string | null
  /** Folder Claude writes this session's transcript under; null leaves it unreported. */
  configDir?: string | null
}

const tabId = (n: number): string => `tab-${n}`
const leafId = (n: number): string => `0195f2ce-1111-4000-8000-00000000000${n}`
const ptyId = (n: number): string => `pty-${n}`

function makeTab(n: number): TerminalTab {
  return {
    id: tabId(n),
    ptyId: ptyId(n),
    worktreeId: 'wt1',
    title: 'claude',
    customTitle: null,
    color: null,
    sortOrder: n,
    createdAt: n
  }
}

function providerSession(pane: SeededPane): AgentStatusEntry['providerSession'] {
  // Why per pane: panes naming one session are a distinct case, seeded explicitly.
  const id = pane.sessionId ?? `${SESSION_ID.slice(0, -1)}${pane.n}`
  const configDir = pane.configDir === undefined ? FOLDER_A : pane.configDir
  return configDir
    ? { key: 'session_id', id, transcriptPath: `${configDir}/projects/-repo/${id}.jsonl` }
    : { key: 'session_id', id }
}

function seedPanes(panes: SeededPane[]): void {
  const statuses: Record<string, AgentStatusEntry> = {}
  for (const pane of panes) {
    if (!pane.agentType) {
      continue
    }
    const paneKey = makePaneKey(tabId(pane.n), leafId(pane.n))
    statuses[paneKey] = {
      paneKey,
      tabId: tabId(pane.n),
      state: pane.state ?? 'done',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      agentType: pane.agentType,
      ...(pane.sessionId === null ? {} : { providerSession: providerSession(pane) })
    }
  }
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/dev'),
      claudeManagedAccounts: [account('acct-a', FOLDER_A), account('acct-b', FOLDER_B)]
    },
    tabsByWorktree: { wt1: panes.map((pane) => makeTab(pane.n)) },
    ptyIdsByTabId: Object.fromEntries(panes.map((pane) => [tabId(pane.n), [ptyId(pane.n)]])),
    terminalLayoutsByTabId: Object.fromEntries(
      panes.map((pane) => [
        tabId(pane.n),
        {
          root: { type: 'leaf', leafId: leafId(pane.n) },
          activeLeafId: leafId(pane.n),
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId(pane.n)]: ptyId(pane.n) }
        }
      ])
    ),
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries(statuses)),
    paneForegroundAgentByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingPaneAccountRestarts: {}
  })
}

const scan = (
  fromAccountId: string | null = 'acct-a',
  target: { runtime: 'host' | 'wsl'; wslDistro?: string } = HOST,
  host?: ClaudeHostFolders,
  toAccountId: string | null = 'acct-c',
  discovered?: ClaudePaneLookups
) =>
  findClaudeSwitchSessions({
    owner: LOCAL,
    target,
    fromAccountId,
    toAccountId,
    host,
    restartAll: restartAllIsSet(),
    discovered
  })

const restartAllIsSet = () =>
  useAppStore.getState().settings?.claudeAccountSwitchRunningSessions === 'restart-all'

const movable = async (...args: Parameters<typeof scan>) =>
  (await scan(...args)).onAccount.map((pane) => pane.ptyId)

beforeEach(() => {
  projectRuntime = undefined
  for (const key of Object.keys(laneByPtyId)) {
    delete laneByPtyId[key]
  }
})

describe('findMovableClaudeSessions', () => {
  beforeEach(() => {
    // Why the version name: the native macOS install reports its version folder, not `claude`.
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: '2.1.258',
      hasChildProcesses: true
    })
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('claude')
  })

  it("keeps a shared session running after the other pane's sidebar row was dismissed", async () => {
    seedPanes([{ n: 1, agentType: 'claude', configDir: FOLDER_A, sessionId: SESSION_ID }, { n: 2 }])
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [makePaneKey(tabId(2), leafId(2))]: {
          paneKey: makePaneKey(tabId(2), leafId(2)),
          worktreeId: 'wt1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: SESSION_ID },
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })

    const found = await scan()

    expect(found.onAccount).toEqual([])
    expect(found.cantMove).toEqual([
      expect.objectContaining({ ptyId: ptyId(1), reason: 'shared-session' })
    ])
  })

  it('leaves a node or python program the user started in a pane Claude has left', async () => {
    seedPanes([
      { n: 1, agentType: 'claude' },
      { n: 2, agentType: 'claude' }
    ])
    const program = (id: string): string => (id === ptyId(1) ? 'node' : 'python3')
    vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) => ({
      foregroundProcess: program(id),
      hasChildProcesses: true
    }))
    // A fresh read of `npm run dev` or `python manage.py runserver` places it as no agent.
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockImplementation(async (id) => program(id))

    expect(await movable()).toEqual([])
  })

  // WSL stores UNC and guest config paths, hooks report guest transcripts, and Windows sees only wsl.exe in the pane tree.
  it('finds WSL panes from the guest hook evidence the Windows process table cannot see', async () => {
    const guestHome = (id: string): string =>
      `/home/dev/.local/share/orca/claude-profiles/${id}/home`
    const wslAccount = (id: string): ClaudeManagedAccount => ({
      ...account(id, `\\\\wsl.localhost\\Ubuntu-24.04${guestHome(id).replace(/\//g, '\\')}`),
      managedAuthRuntime: 'wsl',
      wslDistro: 'Ubuntu-24.04',
      wslLinuxAuthPath: guestHome(id)
    })
    seedPanes([
      { n: 1, agentType: 'claude', configDir: guestHome('acct-a') },
      { n: 2, agentType: 'claude', configDir: guestHome('acct-a') }
    ])
    laneByPtyId[ptyId(1)] = 'wsl:Ubuntu-24.04'
    laneByPtyId[ptyId(2)] = 'wsl:Ubuntu-24.04'
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        claudeManagedAccounts: [wslAccount('acct-a'), wslAccount('acct-b')]
      },
      // OSC 133;D from the guest shell: pane 2's Claude has exited.
      paneForegroundAgentByPaneKey: {
        [makePaneKey(tabId(2), leafId(2))]: { agent: null, shellForeground: true }
      }
    }))
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'wsl.exe',
      hasChildProcesses: true
    })
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue(null)
    projectRuntime = {
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'project-1',
        distro: 'Ubuntu-24.04',
        reason: 'project-override',
        cacheKey: 'project-1:wsl:Ubuntu-24.04'
      }
    }

    expect(await movable('acct-a', { runtime: 'wsl', wslDistro: 'Ubuntu-24.04' })).toEqual([
      ptyId(1)
    ])
  })
})

describe('panes no hook has named', () => {
  const SYSTEM_HOME = '/home/dev/.claude'
  const recorded = (configDir: string, n: number) => {
    const id = `${SESSION_ID.slice(0, -1)}${n}`
    const separator = configDir.includes('\\') ? '\\' : '/'
    const transcriptPath = [configDir, 'projects', 'C--repo', `${id}.jsonl`].join(separator)
    return { key: 'session_id' as const, id, transcriptPath }
  }
  const paneKeyOf = (n: number) => makePaneKey(tabId(n), leafId(n))
  const lookedUp = (...entries: [number, string][]) =>
    new Map(entries.map(([n, configDir]) => [paneKeyOf(n), recorded(configDir, n)]))
  const discoverClaudeSession = vi.fn()
  const settle = (accountId = 'acct-b') =>
    settleQueuedClaudeRestarts({
      owner: LOCAL,
      target: HOST,
      accountId,
      accountLabel: accountId,
      isCurrent: () => true,
      restartAll: restartAllIsSet()
    })

  beforeEach(() => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'claude',
      hasChildProcesses: true
    })
    discoverClaudeSession.mockReset()
    discoverClaudeSession.mockImplementation(async (id: string) => ({
      key: 'session_id',
      id: `session-${id}`,
      transcriptPath: `${FOLDER_A}/projects/-repo/session-${id}.jsonl`
    }))
    vi.stubGlobal('window', { api: { pty: { discoverClaudeSession } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('moves a pane no hook named by its looked-up session, and a named one by its hook', async () => {
    seedPanes([
      { n: 1, agentType: 'claude', configDir: FOLDER_A },
      { n: 2, agentType: 'claude', sessionId: null }
    ])
    const found = new Map([...lookedUp([2, FOLDER_A]), [paneKeyOf(1), recorded(FOLDER_B, 1)]])

    expect(await movable('acct-a', HOST, undefined, 'acct-c', found)).toEqual([ptyId(1), ptyId(2)])
  })

  it('places a record from a Windows account folder on that account', async () => {
    const windowsFolder = 'C:\\Users\\Dev\\AppData\\Roaming\\orca\\claude-profiles\\acct-a\\home'
    seedPanes([{ n: 2, agentType: 'claude', sessionId: null }])
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, claudeManagedAccounts: [account('acct-a', windowsFolder)] }
    }))

    expect(
      await movable('acct-a', HOST, undefined, 'acct-c', lookedUp([2, windowsFolder.toLowerCase()]))
    ).toEqual([ptyId(2)])
  })

  it('groups a pane whose record sits in the System default folder with the other accounts', async () => {
    seedPanes([{ n: 2, agentType: 'claude', sessionId: null }])
    const host = { accounts: [], systemDefaultHome: SYSTEM_HOME }

    const found = await scan('acct-a', HOST, host, 'acct-c', lookedUp([2, SYSTEM_HOME]))

    expect(found.elsewhere).toEqual([expect.objectContaining({ ptyId: ptyId(2), accountId: null })])
    expect(found.cantMove).toEqual([])
  })

  it('looks up only host panes in the lane that no hook or saved record named', async () => {
    seedPanes([
      { n: 1, agentType: 'claude', configDir: FOLDER_B },
      { n: 2, agentType: 'claude', sessionId: null },
      { n: 3, agentType: 'claude', sessionId: null },
      { n: 4, agentType: 'claude', sessionId: null },
      { n: 5, agentType: 'codex', sessionId: null }
    ])
    laneByPtyId[ptyId(3)] = 'wsl:Ubuntu'
    const paneKey = makePaneKey(tabId(4), leafId(4))
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          worktreeId: 'wt1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: SESSION_ID },
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })

    expect([...(await settle()).keys()]).toEqual([paneKeyOf(2)])
  })

  it('names no session for a pane whose lookup failed', async () => {
    seedPanes([{ n: 2, agentType: 'claude', sessionId: null }])
    discoverClaudeSession.mockRejectedValue(new Error('no handler'))

    expect([...(await settle())]).toEqual([[paneKeyOf(2), null]])
  })

  it('cancels a queued restart of a pane no hook named once it is found on the account', async () => {
    seedPanes([{ n: 2, agentType: 'claude', sessionId: null }])
    useAppStore.setState({ pendingPaneAccountRestarts: { [ptyId(2)]: 'claude' } })

    await settle('acct-a')

    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })
})

describe('findQueuedClaudeRestartsOnAccount', () => {
  it('lists queued Claude restarts in the lane whose session already runs on the account', () => {
    seedPanes([
      { n: 1, agentType: 'claude', configDir: FOLDER_B },
      { n: 2, agentType: 'claude', configDir: FOLDER_A },
      { n: 3, agentType: 'claude', configDir: FOLDER_B },
      { n: 4, agentType: 'claude', configDir: FOLDER_B }
    ])
    laneByPtyId[ptyId(4)] = 'wsl:Ubuntu'
    useAppStore.setState({
      pendingPaneAccountRestarts: {
        [ptyId(1)]: 'claude',
        [ptyId(2)]: 'claude',
        [ptyId(4)]: 'claude'
      }
    })

    expect(
      findQueuedClaudeRestartsOnAccount({
        owner: LOCAL,
        target: HOST,
        accountId: 'acct-b',
        restartAll: restartAllIsSet()
      })
    ).toEqual([ptyId(1)])
  })
})
