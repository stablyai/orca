import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import type * as paneSelectionLane from './pane-account-selection-lane'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import {
  CLAUDE_ACCOUNT_SWITCH_AGENT,
  claudeLaunchAccountId,
  resolveClaudeSessionAccountId
} from './claude-account-switch-agent'
import {
  findMovableAgentSessions,
  findQueuedAccountRestartsOnAccount
} from './agent-account-switch-discovery'
import { isAgentPaneMidTurn } from '@/components/terminal-pane/pane-account-restart-readiness'
import {
  SEEDED_SESSION_ID,
  paneKeyOf,
  ptyId,
  seedAgentPanes,
  type SeededAgentPane
} from './agent-account-switch-panes.test-fixture'

const laneByPtyId: Record<string, string> = {}

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))
vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('./pane-account-selection-lane', async (importOriginal) => ({
  ...(await importOriginal<typeof paneSelectionLane>()),
  resolvePaneAccountSelectionLaneKey: ({ ptyId }: { ptyId: string }) => laneByPtyId[ptyId] ?? 'host'
}))

const LOCAL = { kind: 'local' } as const
const HOST = { runtime: 'host' } as const
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

type SeededPane = Omit<SeededAgentPane, 'transcriptPath'> & {
  /** Folder Claude writes this session's transcript under; null leaves it unreported. */
  configDir?: string | null
}

function seedPanes(panes: SeededPane[]): void {
  seedAgentPanes(
    panes.map(({ configDir, ...pane }) => {
      const folder = configDir === undefined ? FOLDER_A : configDir
      return {
        ...pane,
        transcriptPath: folder ? `${folder}/projects/-repo/${SEEDED_SESSION_ID}.jsonl` : null
      }
    }),
    { claudeManagedAccounts: [account('acct-a', FOLDER_A), account('acct-b', FOLDER_B)] }
  )
}

const movable = async (
  fromAccountId: string | null = 'acct-a',
  target: { runtime: 'host' | 'wsl'; wslDistro?: string } = HOST
) =>
  (
    await findMovableAgentSessions(CLAUDE_ACCOUNT_SWITCH_AGENT, {
      owner: LOCAL,
      target,
      fromAccountId
    })
  ).map((pane) => pane.ptyId)

beforeEach(() => {
  for (const key of Object.keys(laneByPtyId)) {
    delete laneByPtyId[key]
  }
})

describe('finding Claude sessions to move', () => {
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

  it("never offers a server's sessions, whose folders its roster does not name, or SSH panes", async () => {
    seedPanes([{ n: 1, agentType: 'claude' }])
    laneByPtyId[ptyId(1)] = 'env:env-1'
    expect(
      await findMovableAgentSessions(CLAUDE_ACCOUNT_SWITCH_AGENT, {
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

describe('isAgentPaneMidTurn', () => {
  it('waits on a reply, a permission prompt or a question, not on an idle session', () => {
    seedPanes([
      { n: 1, agentType: 'claude', state: 'working' },
      { n: 2, agentType: 'claude', state: 'blocked' },
      { n: 3, agentType: 'claude', state: 'waiting' },
      { n: 4, agentType: 'claude', state: 'done' }
    ])
    const state = useAppStore.getState()
    const midTurn = [1, 2, 3, 4].map((n) => isAgentPaneMidTurn(state, paneKeyOf(n), 'claude'))

    expect(midTurn).toEqual([true, true, true, false])
  })
})

describe('queued Claude restarts already on the account', () => {
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
      findQueuedAccountRestartsOnAccount(CLAUDE_ACCOUNT_SWITCH_AGENT, {
        owner: LOCAL,
        target: HOST,
        accountId: 'acct-b'
      })
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
