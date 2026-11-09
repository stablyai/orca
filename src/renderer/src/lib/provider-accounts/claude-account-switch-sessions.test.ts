import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/claude-account-switch-settings'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import { findClaudeSwitchSessions } from '../agent-session/accounts/claude/claude-session-account-move'
import type * as AccountMove from '../agent-session/accounts/claude/claude-session-account-move'
import type { ClaudeSwitchSessions } from '../agent-session/accounts/claude/claude-session-account-move'
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
const toastWarning = vi.hoisted(() => vi.fn())

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, warning: toastWarning } }))
vi.mock('../agent-session/accounts/claude/claude-session-account-move', async (importOriginal) => ({
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

describe('handleRunningClaudeSessionsAfterSwitch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeAccountSwitchSessionsForTests()
    store.settings = {}
    store.terminalLayoutsByTabId = Object.fromEntries(
      [1, 2, 3].map((n) => [`tab-${n}`, { ptyIdsByLeafId: { [`leaf-${n}`]: `pty-${n}` } }])
    )
  })

  it('restarts a pane on the PTY it has now, and skips a pane that closed', async () => {
    vi.mocked(findClaudeSwitchSessions).mockResolvedValue(scan([candidate(1), candidate(2)]))
    await handleRunningClaudeSessionsAfterSwitch(SWITCH)
    store.terminalLayoutsByTabId = { 'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1-reattached' } } }

    answerClaudeAccountSwitchPrompt('restart')

    expect(store.queuePaneAccountRestarts).toHaveBeenLastCalledWith(['pty-1-reattached'], 'claude')
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
