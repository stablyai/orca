import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
import type * as AccountMove from './claude-session-account-move'
import {
  getClaudeAccountSwitchPrompt,
  resetClaudeAccountSwitchSessionsForTests
} from './claude-account-switch-sessions'
import { followClaudeAutoSwitch } from './claude-auto-switch-follow'

type StoreStub = {
  settings: { claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions }
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }>
  updateSettings: () => Promise<void>
  queuePaneAccountRestarts: (ptyIds: string[], agent: string) => void
  consumePendingPaneAccountRestart: (ptyId: string) => void
}

const store = vi.hoisted((): StoreStub => ({
  settings: {},
  terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1' } } },
  updateSettings: vi.fn(async () => {}),
  queuePaneAccountRestarts: vi.fn(),
  consumePendingPaneAccountRestart: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('./claude-session-account-move', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountMove>()),
  findMovableClaudeSessions: vi.fn(async () => [
    { ptyId: 'pty-1', worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' }
  ]),
  findQueuedClaudeRestartsOnAccount: vi.fn(() => [])
}))

const row = (id: string) => ({
  id,
  email: `${id}@example.com`,
  managedAuthRuntime: 'host' as const,
  wslDistro: null,
  authMethod: 'subscription-oauth' as const,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
})
const ROSTER = { accounts: [row('account-a'), row('account-b')] }
const SWITCHED = {
  accounts: ROSTER.accounts,
  fromAccountId: 'account-a',
  toAccountId: 'account-b',
  target: { runtime: 'host' as const, wslDistro: null }
}

describe('followClaudeAutoSwitch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClaudeAccountSwitchSessionsForTests()
    store.settings = {}
    // Why never answering: the switch carries its accounts, so nothing waits on a read meanwhile.
    vi.stubGlobal('window', {
      api: { claudeAccounts: { list: () => new Promise<typeof ROSTER>(() => {}) } }
    })
  })

  it('restarts sessions still on the old account when the setting is Always restart', async () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'restart' }

    await followClaudeAutoSwitch(SWITCHED)

    expect(store.queuePaneAccountRestarts).toHaveBeenCalledWith(['pty-1'], 'claude')
  })

  it('asks about them by default, as a switch by hand does', async () => {
    await followClaudeAutoSwitch(SWITCHED)

    expect(getClaudeAccountSwitchPrompt()?.sessions).toHaveLength(1)
    expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
  })
})
