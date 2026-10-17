import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccountSwitchSettings } from '../../../shared/agent-account-switch-settings'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../shared/managed-account-types'
import {
  getClaudeStatusActiveId,
  resolveClaudeStatusAccountState
} from '../components/status-bar/status-bar-claude-accounts'
import {
  findMovableAgentSessions,
  findQueuedAccountRestartsOnAccount
} from './agent-account-switch-discovery'
import type * as Discovery from './agent-account-switch-discovery'
import type { AccountSwitchAgent } from './agent-account-switch-agent'
import { CLAUDE_ACCOUNT_SWITCH_AGENT } from './claude-account-switch-agent'
import { CODEX_ACCOUNT_SWITCH_AGENT } from './codex-account-switch-agent'
import {
  answerAgentAccountSwitchPrompt,
  getAgentAccountSwitchPrompt,
  handleRunningAgentSessionsAfterSwitch,
  resetAgentAccountSwitchSessionsForTests
} from './agent-account-switch-sessions'

type StoreStub = {
  settings: AgentAccountSwitchSettings
  updateSettings: (updates: AgentAccountSwitchSettings) => Promise<void>
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }>
  queuePaneAccountRestarts: (ptyIds: string[], agent: string) => void
  consumePendingPaneAccountRestart: (ptyId: string) => void
}

const store = vi.hoisted((): StoreStub => ({
  settings: {},
  terminalLayoutsByTabId: {},
  updateSettings: vi.fn(async () => {}),
  queuePaneAccountRestarts: vi.fn(),
  consumePendingPaneAccountRestart: vi.fn()
}))
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))
vi.mock('./agent-account-switch-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof Discovery>()),
  findMovableAgentSessions: vi.fn(),
  findQueuedAccountRestartsOnAccount: vi.fn(() => [])
}))

const CLAUDE = CLAUDE_ACCOUNT_SWITCH_AGENT
const CODEX = CODEX_ACCOUNT_SWITCH_AGENT
const candidate = (n: number) => ({
  ptyId: `pty-${n}`,
  worktreeId: 'wt-1',
  tabId: `tab-${n}`,
  leafId: `leaf-${n}`
})
const row = (id: string, extra: Partial<ClaudeManagedAccountSummary> = {}) => ({
  id,
  email: `${id}@example.com`,
  managedAuthRuntime: 'host' as const,
  wslDistro: null,
  authMethod: 'subscription-oauth' as const,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1,
  ...extra
})
const ROSTER = { accounts: [row('account-a'), row('account-b')] }
const SWITCH = {
  owner: { kind: 'local' } as const,
  target: { runtime: 'host' } as const,
  before: { state: ROSTER, accountId: 'account-a' },
  after: { state: ROSTER, accountId: 'account-b' }
}
const SWITCH_BACK = { ...SWITCH, before: SWITCH.after, after: SWITCH.before }
const wslSwitch = (wslDistro: string | null) => ({
  ...SWITCH,
  target: { runtime: 'wsl', wslDistro } as const
})

const switchAgent = (
  agent: AccountSwitchAgent,
  args: Partial<Parameters<typeof handleRunningAgentSessionsAfterSwitch>[1]> = {}
) => handleRunningAgentSessionsAfterSwitch(agent, { ...SWITCH, ...args })
const listed = (): string[] | undefined =>
  getAgentAccountSwitchPrompt()?.sessions.map((session) => session.ptyId)

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentAccountSwitchSessionsForTests()
  store.settings = {}
  store.terminalLayoutsByTabId = Object.fromEntries(
    [1, 2, 3].map((n) => [`tab-${n}`, { ptyIdsByLeafId: { [`leaf-${n}`]: `pty-${n}` } }])
  )
  vi.mocked(findMovableAgentSessions).mockResolvedValue([])
})

describe.each([CLAUDE, CODEX])('the $agent account switch', (agent) => {
  it('asks nothing when no session runs on the outgoing account', async () => {
    expect(await switchAgent(agent)).toBe('show-confirmation')
    expect(getAgentAccountSwitchPrompt()).toBeNull()
    expect(findMovableAgentSessions).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({ fromAccountId: 'account-a' })
    )
  })

  it('restarts the listed sessions on the new account when the user picks Restart', async () => {
    vi.mocked(findMovableAgentSessions).mockResolvedValue([candidate(1), candidate(2)])
    expect(await switchAgent(agent)).toBe('handled')
    expect(getAgentAccountSwitchPrompt()).toMatchObject({
      agent,
      previousAccountLabel: 'account-a@example.com',
      nextAccountLabel: 'account-b@example.com'
    })

    answerAgentAccountSwitchPrompt('restart')

    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-1', 'pty-2'], agent.agent)
    expect(getAgentAccountSwitchPrompt()).toBeNull()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('restarts only ticked sessions this question listed, on the PTY each has now', async () => {
    vi.mocked(findMovableAgentSessions).mockResolvedValue([candidate(1), candidate(2)])
    await switchAgent(agent)
    // A reattach moved pane 1 onto a new PTY while the question was open.
    store.terminalLayoutsByTabId['tab-1'] = { ptyIdsByLeafId: { 'leaf-1': 'pty-1-reattached' } }

    answerAgentAccountSwitchPrompt('restart', { ptyIds: ['pty-1', 'pty-unlisted'] })

    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(
      ['pty-1-reattached'],
      agent.agent
    )
  })

  it('queues nothing for a pane closed while the question was open', async () => {
    vi.mocked(findMovableAgentSessions).mockResolvedValue([candidate(1)])
    await switchAgent(agent)
    store.terminalLayoutsByTabId = {}

    answerAgentAccountSwitchPrompt('restart')

    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
  })

  it('leaves sessions alone when the user keeps them', async () => {
    vi.mocked(findMovableAgentSessions).mockResolvedValue([candidate(1)])
    await switchAgent(agent)

    answerAgentAccountSwitchPrompt('keep')

    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
    expect(getAgentAccountSwitchPrompt()).toBeNull()
  })

  it.each(['restart', 'keep'] as const)(
    "turns on the agent's own automatic restarts on %s when told not to ask again",
    async (answer) => {
      vi.mocked(findMovableAgentSessions).mockResolvedValue([candidate(1)])
      await switchAgent(agent)

      answerAgentAccountSwitchPrompt(answer, { dontAskAgain: true })

      expect(store.updateSettings).toHaveBeenCalledWith({ [agent.settingKey]: 'restart' })
    }
  )

  it('restarts without asking when the setting is Always restart', async () => {
    store.settings = { [agent.settingKey]: 'restart' }
    vi.mocked(findMovableAgentSessions).mockResolvedValue([candidate(1), candidate(2)])

    expect(await switchAgent(agent)).toBe('handled')
    expect(getAgentAccountSwitchPrompt()).toBeNull()
    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-1', 'pty-2'], agent.agent)
    expect(toastSuccess).toHaveBeenCalledWith(
      `Restarting 2 ${agent.agent === 'claude' ? 'Claude' : 'Codex'} sessions on account-b@example.com`
    )
  })

  it('keeps sessions without scanning when the setting is Never restart', async () => {
    store.settings = { [agent.settingKey]: 'keep' }
    vi.mocked(findQueuedAccountRestartsOnAccount).mockReturnValueOnce(['pty-home'])

    expect(await switchAgent(agent)).toBe('show-confirmation')
    expect(findMovableAgentSessions).not.toHaveBeenCalled()
    expect(store.consumePendingPaneAccountRestart).toHaveBeenCalledWith('pty-home')
    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
  })

  it('applies Never restart chosen while the scan runs', async () => {
    vi.mocked(findMovableAgentSessions).mockImplementation(async () => {
      store.settings = { [agent.settingKey]: 'keep' }
      return [candidate(1)]
    })

    expect(await switchAgent(agent)).toBe('show-confirmation')
    expect(getAgentAccountSwitchPrompt()).toBeNull()
  })

  it('drops queued restarts already on the new account and keeps the rest', async () => {
    vi.mocked(findQueuedAccountRestartsOnAccount).mockReturnValueOnce(['pty-home'])

    await switchAgent(agent)

    expect(findQueuedAccountRestartsOnAccount).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({ accountId: 'account-b' })
    )
    expect(store.consumePendingPaneAccountRestart).toHaveBeenCalledTimes(1)
    expect(store.consumePendingPaneAccountRestart).toHaveBeenCalledWith('pty-home')
  })

  it("asks about a server's sessions in their own question, leaving the local one open", async () => {
    vi.mocked(findMovableAgentSessions)
      .mockResolvedValueOnce([candidate(1)])
      .mockResolvedValueOnce([candidate(2)])
    await switchAgent(agent)
    const serverSwitch = {
      ...SWITCH,
      owner: { kind: 'environment', environmentId: 'env-1' } as const
    }

    expect(await handleRunningAgentSessionsAfterSwitch(agent, serverSwitch)).toBe('handled')
    expect(findMovableAgentSessions).toHaveBeenLastCalledWith(
      agent,
      expect.objectContaining({ owner: serverSwitch.owner })
    )

    expect(listed()).toEqual(['pty-1'])
    answerAgentAccountSwitchPrompt('keep')
    expect(listed()).toEqual(['pty-2'])
  })

  it('asks nothing when the account does not change', async () => {
    expect(await switchAgent(agent, { after: SWITCH.before })).toBe('show-confirmation')
    expect(findMovableAgentSessions).not.toHaveBeenCalled()
  })

  it('keeps only the newer question when an older scan resolves last', async () => {
    const older = Promise.withResolvers<ReturnType<typeof candidate>[]>()
    const newer = Promise.withResolvers<ReturnType<typeof candidate>[]>()
    vi.mocked(findMovableAgentSessions)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const first = switchAgent(agent)
    const second = handleRunningAgentSessionsAfterSwitch(agent, SWITCH_BACK)

    newer.resolve([candidate(2)])
    expect(await second).toBe('handled')
    older.resolve([candidate(1)])
    expect(await first).toBe('handled')

    expect(listed()).toEqual(['pty-2'])
    expect(getAgentAccountSwitchPrompt()?.nextAccountLabel).toBe('account-a@example.com')
  })
})

describe('questions across agents and lanes', () => {
  it('shows a waiting question once the one before it is answered', async () => {
    vi.mocked(findMovableAgentSessions)
      .mockResolvedValueOnce([candidate(1)])
      .mockResolvedValueOnce([candidate(2)])
    await switchAgent(CLAUDE)
    await switchAgent(CODEX)

    expect(getAgentAccountSwitchPrompt()?.agent).toBe(CLAUDE)
    answerAgentAccountSwitchPrompt('keep')
    expect(getAgentAccountSwitchPrompt()?.agent).toBe(CODEX)
  })

  it('reads each agent its own setting', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'keep' }
    vi.mocked(findMovableAgentSessions).mockResolvedValue([candidate(1)])

    expect(await switchAgent(CODEX)).toBe('handled')
    expect(getAgentAccountSwitchPrompt()?.agent).toBe(CODEX)
  })

  it('keeps the host question open through a WSL switch', async () => {
    vi.mocked(findMovableAgentSessions)
      .mockResolvedValueOnce([candidate(1)])
      .mockResolvedValueOnce([candidate(2)])
    await switchAgent(CODEX)
    await switchAgent(CODEX, wslSwitch('Ubuntu'))

    expect(listed()).toEqual(['pty-1'])
    answerAgentAccountSwitchPrompt('keep')
    expect(listed()).toEqual(['pty-2'])
  })

  it('lets clearing every WSL distro replace a single distro question', async () => {
    vi.mocked(findMovableAgentSessions)
      .mockResolvedValueOnce([candidate(1)])
      .mockResolvedValueOnce([candidate(2)])
      .mockResolvedValueOnce([candidate(3)])
    await switchAgent(CODEX)
    await switchAgent(CODEX, wslSwitch('Ubuntu'))
    await handleRunningAgentSessionsAfterSwitch(CODEX, {
      ...wslSwitch(null),
      clearsEveryWslDistro: true
    })

    expect(listed()).toEqual(['pty-1'])
    answerAgentAccountSwitchPrompt('keep')
    expect(listed()).toEqual(['pty-3'])
    answerAgentAccountSwitchPrompt('keep')
    expect(getAgentAccountSwitchPrompt()).toBeNull()
  })

  describe('a distro scan still running when every WSL distro is cleared', () => {
    const clearEveryWsl = () =>
      handleRunningAgentSessionsAfterSwitch(CODEX, {
        ...wslSwitch(null),
        clearsEveryWslDistro: true
      })
    const startOverlappingScans = () => {
      const distro = Promise.withResolvers<ReturnType<typeof candidate>[]>()
      const everyWsl = Promise.withResolvers<ReturnType<typeof candidate>[]>()
      vi.mocked(findMovableAgentSessions)
        .mockReturnValueOnce(distro.promise)
        .mockReturnValueOnce(everyWsl.promise)
      return {
        distro,
        everyWsl,
        distroDone: switchAgent(CODEX, wslSwitch('Ubuntu')),
        everyWslDone: clearEveryWsl()
      }
    }

    it('drops the distro question when its scan finishes last', async () => {
      const scans = startOverlappingScans()
      scans.everyWsl.resolve([candidate(2)])
      expect(await scans.everyWslDone).toBe('handled')
      scans.distro.resolve([candidate(1)])
      expect(await scans.distroDone).toBe('handled')

      expect(listed()).toEqual(['pty-2'])
      answerAgentAccountSwitchPrompt('keep')
      expect(getAgentAccountSwitchPrompt()).toBeNull()
    })

    it('drops the distro question when its scan finishes first', async () => {
      const scans = startOverlappingScans()
      scans.distro.resolve([candidate(1)])
      expect(await scans.distroDone).toBe('handled')
      expect(getAgentAccountSwitchPrompt()).toBeNull()
      scans.everyWsl.resolve([candidate(2)])
      expect(await scans.everyWslDone).toBe('handled')

      expect(listed()).toEqual(['pty-2'])
      answerAgentAccountSwitchPrompt('keep')
      expect(getAgentAccountSwitchPrompt()).toBeNull()
    })

    it('restarts only the newer switch sessions under Always restart', async () => {
      store.settings = { codexAccountSwitchRunningSessions: 'restart' }
      const scans = startOverlappingScans()
      scans.everyWsl.resolve([candidate(2)])
      await scans.everyWslDone
      scans.distro.resolve([candidate(1)])
      await scans.distroDone

      expect(store.queuePaneAccountRestarts).toHaveBeenCalledTimes(1)
      expect(store.queuePaneAccountRestarts).toHaveBeenCalledWith(['pty-2'], 'codex')
      expect(toastSuccess).toHaveBeenCalledTimes(1)
    })
  })
})

describe('switching from a saved Claude account that runs on System default, as the status bar shows it', () => {
  const host: ClaudeRateLimitAccountsState = {
    accounts: [row('account-a', { runsOnSystemDefault: true }), row('account-b')],
    activeAccountId: 'account-a',
    activeAccountIdsByRuntime: { host: 'account-a', wsl: {} }
  }
  const settingsSelecting = (accountId: string | null): GlobalSettings => ({
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: [
      { ...row('account-a'), managedAuthPath: '/claude/account-a' },
      { ...row('account-b'), managedAuthPath: '/claude/account-b' }
    ],
    activeClaudeManagedAccountId: accountId,
    activeClaudeManagedAccountIdsByRuntime: { host: accountId, wsl: {} }
  })
  const hostTarget = { runtime: 'host', wslDistro: null } as const
  const before = resolveClaudeStatusAccountState(settingsSelecting('account-a'), host, null)
  const switchTo = (hostAccountId: string | null) => {
    const after = { ...host, activeAccountIdsByRuntime: { host: hostAccountId, wsl: {} } }
    return handleRunningAgentSessionsAfterSwitch(CLAUDE, {
      owner: { kind: 'local' },
      target: hostTarget,
      before: { state: before, accountId: getClaudeStatusActiveId(before, hostTarget) },
      after: { state: after, accountId: getClaudeStatusActiveId(after, hostTarget) }
    })
  }

  it('looks for its sessions on System default when switching to another account', async () => {
    await switchTo('account-b')

    expect(findMovableAgentSessions).toHaveBeenCalledWith(
      CLAUDE,
      expect.objectContaining({ fromAccountId: null })
    )
  })

  it('moves nothing when switching to System default itself', async () => {
    expect(await switchTo(null)).toBe('show-confirmation')
    expect(findMovableAgentSessions).not.toHaveBeenCalled()
  })
})
