import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
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
  findClaudeSwitchSessions,
  findQueuedClaudeRestartsOnAccount
} from './claude-session-account-move'
import type * as AccountMove from './claude-session-account-move'
import type { ClaudeSwitchSessions } from './claude-session-account-move'
import {
  answerClaudeAccountSwitchPrompt,
  getClaudeAccountSwitchPrompt,
  handleRunningClaudeSessionsAfterSwitch,
  resetClaudeAccountSwitchSessionsForTests
} from './claude-account-switch-sessions'

type SwitchSettings = { claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions }

type StoreStub = {
  settings: SwitchSettings
  updateSettings: (updates: SwitchSettings) => Promise<void>
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
vi.mock('./claude-session-account-move', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountMove>()),
  findClaudeSwitchSessions: vi.fn(),
  findQueuedClaudeRestartsOnAccount: vi.fn(() => [])
}))

const candidate = (n: number) => ({
  ptyId: `pty-${n}`,
  worktreeId: 'wt-1',
  tabId: `tab-${n}`,
  leafId: `leaf-${n}`
})
const scan = (
  onAccount: ReturnType<typeof candidate>[],
  others: Partial<ClaudeSwitchSessions> = {}
): ClaudeSwitchSessions => ({ onAccount, elsewhere: [], cantMove: [], ...others })
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
const SAME_FOLDER = {
  ...SWITCH,
  before: { state: ROSTER, accountId: null },
  after: { state: ROSTER, accountId: null }
}

describe('handleRunningClaudeSessionsAfterSwitch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeAccountSwitchSessionsForTests()
    store.settings = {}
    store.terminalLayoutsByTabId = Object.fromEntries(
      [1, 2, 3].map((n) => [`tab-${n}`, { ptyIdsByLeafId: { [`leaf-${n}`]: `pty-${n}` } }])
    )
  })

  it('asks nothing when no Claude session runs on the outgoing account', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([]))

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('show-confirmation')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(findClaudeSwitchSessions).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: 'account-a' })
    )
  })

  it('keeps earlier queued restarts except those already on the new account', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([]))
    vi.mocked(findQueuedClaudeRestartsOnAccount).mockReturnValueOnce(['pty-home'])

    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    expect(findQueuedClaudeRestartsOnAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-b' })
    )
    expect(store.consumePendingPaneAccountRestart).toHaveBeenCalledTimes(1)
    expect(store.consumePendingPaneAccountRestart).toHaveBeenCalledWith('pty-home')
    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
  })

  it('leaves local questions and queued restarts alone on a server account switch', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1)]))
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    expect(
      await handleRunningClaudeSessionsAfterSwitch({
        ...SWITCH,
        owner: { kind: 'environment', environmentId: 'env-1' }
      })
    ).toBe('show-confirmation')

    expect(
      getClaudeAccountSwitchPrompt()?.sessions.onAccount.map((session) => session.ptyId)
    ).toEqual(['pty-1'])
    expect(findQueuedClaudeRestartsOnAccount).toHaveBeenCalledTimes(1)
  })

  it('restarts on the new account when the user picks Restart', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1), candidate(2)]))
    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('handled')
    expect(
      getClaudeAccountSwitchPrompt()?.sessions.onAccount.map((session) => session.ptyId)
    ).toEqual(['pty-1', 'pty-2'])

    answerClaudeAccountSwitchPrompt('restart')

    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-1', 'pty-2'], 'claude')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('restarts only the ticked sessions, and only ones this question listed', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1), candidate(2)]))
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    answerClaudeAccountSwitchPrompt('restart', { ptyIds: ['pty-2', 'pty-unlisted'] })

    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-2'], 'claude')
  })

  it('restarts a pane on the PTY it has now, and skips a pane that closed', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1), candidate(2)]))
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)
    store.terminalLayoutsByTabId = { 'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1-reattached' } } }

    answerClaudeAccountSwitchPrompt('restart')

    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-1-reattached'], 'claude')
  })

  it('asks nothing when launches run on the same folder before and after the switch', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1)]))

    expect(await handleRunningClaudeSessionsAfterSwitch(SAME_FOLDER)).toBe('show-confirmation')
    expect(findClaudeSwitchSessions).not.toHaveBeenCalled()
  })

  it('leaves sessions alone when the user keeps them', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1)]))
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)

    answerClaudeAccountSwitchPrompt('keep')

    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
  })

  it.each(['restart', 'keep'] as const)(
    'turns on automatic restarts on %s when told not to ask again',
    async (answer) => {
      vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1)]))
      await handleRunningClaudeSessionsAfterSwitch(SWITCH)

      answerClaudeAccountSwitchPrompt(answer, { dontAskAgain: true })

      expect(store.updateSettings).toHaveBeenCalledWith({
        claudeAccountSwitchRunningSessions: 'restart'
      })
    }
  )

  it('restarts without asking when the setting is Always restart', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'restart' }
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1), candidate(2)]))

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('handled')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-1', 'pty-2'], 'claude')
    expect(toastSuccess).toHaveBeenCalledWith(
      'Restarting 2 Claude sessions on account-b@example.com'
    )
  })

  it('names sessions an automatic restart left behind, and reviews only those', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'restart' }
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(
      scan([candidate(1)], {
        elsewhere: [{ ...candidate(2), accountId: null }],
        cantMove: [{ ...candidate(3), reason: 'own-folder' }]
      })
    )

    await handleRunningClaudeSessionsAfterSwitch(SWITCH)
    const [, options] = toastSuccess.mock.lastCall!
    expect(options.description).toBe("2 other sessions weren't moved.")
    options.action.onClick()

    expect(getClaudeAccountSwitchPrompt()).toMatchObject({
      review: true,
      sessions: {
        onAccount: [],
        elsewhere: [expect.objectContaining({ ptyId: 'pty-2', accountLabel: 'System default' })],
        cantMove: [expect.objectContaining({ ptyId: 'pty-3' })]
      }
    })
    answerClaudeAccountSwitchPrompt('restart')
    expect(store.queuePaneAccountRestarts).toHaveBeenNthCalledWith(1, ['pty-1'], 'claude')
    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-2'], 'claude')
  })

  it('keeps sessions without scanning when the setting is Never restart', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'keep' }
    vi.mocked(findQueuedClaudeRestartsOnAccount).mockReturnValueOnce(['pty-home'])

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('show-confirmation')
    expect(findClaudeSwitchSessions).not.toHaveBeenCalled()
    expect(store.consumePendingPaneAccountRestart).toHaveBeenCalledWith('pty-home')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
  })

  it('applies Never restart chosen while the scan runs', async () => {
    vi.mocked(findClaudeSwitchSessions).mockImplementation(async () => {
      store.settings = { claudeAccountSwitchRunningSessions: 'keep' }
      return scan([candidate(1)])
    })

    expect(await handleRunningClaudeSessionsAfterSwitch(SWITCH)).toBe('show-confirmation')
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
  })

  it('keeps only the newer question when an older scan resolves last', async () => {
    const older = Promise.withResolvers<ClaudeSwitchSessions>()
    const newer = Promise.withResolvers<ClaudeSwitchSessions>()
    vi.mocked(findClaudeSwitchSessions)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const first = handleRunningClaudeSessionsAfterSwitch(SWITCH)
    const second = handleRunningClaudeSessionsAfterSwitch({
      ...SWITCH,
      before: SWITCH.after,
      after: SWITCH.before
    })

    newer.resolve(scan([candidate(2)]))
    expect(await second).toBe('handled')
    older.resolve(scan([candidate(1)]))
    expect(await first).toBe('handled')

    expect(getClaudeAccountSwitchPrompt()).toMatchObject({
      sessions: { onAccount: [expect.objectContaining({ ptyId: 'pty-2' })] },
      nextAccountLabel: 'account-a@example.com'
    })
  })
})

describe('switching from a saved account that runs on System default, as the status bar shows it', () => {
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

  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeAccountSwitchSessionsForTests()
    store.settings = {}
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([]))
  })

  it('looks for its sessions on System default when switching to another account', async () => {
    const after = { ...host, activeAccountIdsByRuntime: { host: 'account-b', wsl: {} } }

    await handleRunningClaudeSessionsAfterSwitch({
      owner: { kind: 'local' },
      target: hostTarget,
      before: { state: before, accountId: getClaudeStatusActiveId(before, hostTarget) },
      after: { state: after, accountId: getClaudeStatusActiveId(after, hostTarget) }
    })

    expect(findClaudeSwitchSessions).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: null })
    )
  })

  it('moves nothing when switching to System default itself', async () => {
    const after = { ...host, activeAccountIdsByRuntime: { host: null, wsl: {} } }

    expect(
      await handleRunningClaudeSessionsAfterSwitch({
        owner: { kind: 'local' },
        target: hostTarget,
        before: { state: before, accountId: getClaudeStatusActiveId(before, hostTarget) },
        after: { state: after, accountId: getClaudeStatusActiveId(after, hostTarget) }
      })
    ).toBe('show-confirmation')
    expect(findClaudeSwitchSessions).not.toHaveBeenCalled()
  })
})
