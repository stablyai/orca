import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { getDefaultSettings } from '../../../shared/constants'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import type * as paneSelectionLane from './codex-pane-selection-lane'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import {
  claudeLaunchAccountId,
  findMovableClaudeSessions,
  findQueuedClaudeRestartsOnAccount,
  isClaudePaneMidTurn,
  resolveClaudeSessionAccountId
} from './claude-session-account-move'

const laneByPtyId: Record<string, string> = {}

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))
vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('./codex-pane-selection-lane', async (importOriginal) => ({
  ...(await importOriginal<typeof paneSelectionLane>()),
  resolveCodexPaneSelectionLane: ({ ptyId }: { ptyId: string }) => ({
    laneKey: laneByPtyId[ptyId] ?? 'host',
    source: 'derived',
    derivedLaneKey: null
  })
}))

const LOCAL = { kind: 'local' } as const
const HOST = { runtime: 'host' } as const
const SESSION_ID = '01a006a6-1d07-70a1-bad5-f9110d5845c0'
const FOLDER_A = '/data/claude-accounts/acct-a'
const FOLDER_B = '/data/claude-accounts/acct-b'
const SYSTEM_FOLDER = '/home/dev/.claude'

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
  const id = pane.sessionId ?? SESSION_ID
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
    agentStatusByPaneKey: statuses,
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingPaneAccountRestarts: {}
  })
}

const movable = async (
  fromAccountId: string | null = 'acct-a',
  target: { runtime: 'host' | 'wsl'; wslDistro?: string } = HOST
) =>
  (await findMovableClaudeSessions({ owner: LOCAL, target, fromAccountId })).map(
    (pane) => pane.ptyId
  )

beforeEach(() => {
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

  it('finds resumable Claude panes and skips other agents and session-less panes', async () => {
    seedPanes([
      { n: 1, agentType: 'claude' },
      { n: 2, agentType: 'codex' },
      { n: 3, agentType: 'claude', sessionId: null },
      { n: 4 }
    ])

    expect(await movable()).toEqual([ptyId(1)])
  })

  it('counts only sessions running on the outgoing account', async () => {
    seedPanes([
      { n: 1, agentType: 'claude', configDir: FOLDER_A },
      { n: 2, agentType: 'claude', configDir: FOLDER_B },
      { n: 3, agentType: 'claude', configDir: SYSTEM_FOLDER },
      { n: 4, agentType: 'claude', configDir: null }
    ])

    expect(await movable('acct-a')).toEqual([ptyId(1)])
    expect(await movable(null)).toEqual([ptyId(3)])
  })

  it('keeps a host switch off WSL panes and a WSL switch on its own distro', async () => {
    seedPanes([
      { n: 1, agentType: 'claude' },
      { n: 2, agentType: 'claude' },
      { n: 3, agentType: 'claude' }
    ])
    laneByPtyId[ptyId(2)] = 'wsl:Ubuntu'
    laneByPtyId[ptyId(3)] = 'wsl:Debian'

    expect(await movable()).toEqual([ptyId(1)])
    expect(await movable('acct-a', { runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual([ptyId(2)])
  })

  it('never offers a move for a remote-server switch or SSH panes', async () => {
    seedPanes([{ n: 1, agentType: 'claude' }])
    expect(
      await findMovableClaudeSessions({
        owner: { kind: 'environment', environmentId: 'env-1' },
        target: HOST,
        fromAccountId: 'acct-a'
      })
    ).toEqual([])

    laneByPtyId[ptyId(1)] = 'ssh-connection'
    expect(await movable()).toEqual([])
  })

  it('skips a pane where Claude has exited to the shell', async () => {
    seedPanes([{ n: 1, agentType: 'claude' }])
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('zsh')

    expect(await movable()).toEqual([])
  })
})

describe('resolveClaudeSessionAccountId', () => {
  const accounts = [account('acct-a', FOLDER_A)]

  it('reads the account from the transcript folder, with System default as the rest', () => {
    expect(resolveClaudeSessionAccountId(`${FOLDER_A}/projects/-repo/s.jsonl`, accounts)).toBe(
      'acct-a'
    )
    expect(
      resolveClaudeSessionAccountId(`${SYSTEM_FOLDER}/projects/-repo/s.jsonl`, accounts)
    ).toBeNull()
    expect(resolveClaudeSessionAccountId(undefined, accounts)).toBeUndefined()
  })

  it('matches Windows paths whatever their separators', () => {
    const windowsAccounts = [account('acct-w', 'C:\\Users\\dev\\claude\\acct-w')]
    expect(
      resolveClaudeSessionAccountId(
        'C:\\Users\\dev\\claude\\acct-w\\projects\\-repo\\s.jsonl',
        windowsAccounts
      )
    ).toBe('acct-w')
  })
})

describe('isClaudePaneMidTurn', () => {
  it('waits on a reply, a permission prompt or a question, not on an idle session', () => {
    seedPanes([
      { n: 1, agentType: 'claude', state: 'working' },
      { n: 2, agentType: 'claude', state: 'blocked' },
      { n: 3, agentType: 'claude', state: 'waiting' },
      { n: 4, agentType: 'claude', state: 'done' }
    ])
    const state = useAppStore.getState()
    const midTurn = [1, 2, 3, 4].map((n) =>
      isClaudePaneMidTurn(state, makePaneKey(tabId(n), leafId(n)))
    )

    expect(midTurn).toEqual([true, true, true, false])
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
      findQueuedClaudeRestartsOnAccount({ owner: LOCAL, target: HOST, accountId: 'acct-b' })
    ).toEqual([ptyId(1)])
  })
})

describe('claudeLaunchAccountId', () => {
  it('reads an account System default covers as System default, where its sessions run', () => {
    const covered = { ...account('acct-a', FOLDER_A), runsOnSystemDefault: true as const }
    const own = account('acct-b', FOLDER_B)

    expect(claudeLaunchAccountId({ accounts: [covered, own] }, 'acct-a')).toBeNull()
    expect(claudeLaunchAccountId({ accounts: [covered, own] }, 'acct-b')).toBe('acct-b')
    expect(claudeLaunchAccountId({ accounts: [covered, own] }, null)).toBeNull()
  })
})
