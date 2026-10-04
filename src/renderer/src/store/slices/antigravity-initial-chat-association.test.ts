import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { createTestStore, makeTab, makeUnifiedTab } from './store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const WORKSPACE = 'folder-workspace'
const TAB = 'agy-tab'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey(TAB, LEAF)
let store: ReturnType<typeof createTestStore>

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn(async () => {}) } } })
  store = createTestStore()
  store.setState({
    settings: {
      ...createGlobalSettingsFixture(),
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      agentStatusHooksEnabled: false,
      agentWorkspaceTrustEnabled: false
    },
    tabsByWorktree: {
      [WORKSPACE]: [makeTab({ id: TAB, worktreeId: WORKSPACE, launchAgent: 'antigravity' })]
    },
    unifiedTabsByWorktree: {
      [WORKSPACE]: [makeUnifiedTab({ id: TAB, worktreeId: WORKSPACE, groupId: 'group' })]
    },
    terminalLayoutsByTabId: {
      [TAB]: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function associate(
  args: {
    id?: string
    key?: 'conversation_id' | 'session_id'
    restored?: boolean
    connectionId?: string | null
    at?: number
  } = {}
) {
  store.getState().setAgentStatus(
    PANE,
    {
      agentType: 'antigravity',
      state: 'working',
      prompt: '',
      ...(args.restored ? { restoredUnconfirmed: true } : {})
    },
    'Antigravity',
    { updatedAt: args.at ?? 10, stateStartedAt: 10 },
    { tabId: TAB, worktreeId: WORKSPACE, connectionId: args.connectionId ?? null },
    args.id ? { providerSession: { key: args.key ?? 'conversation_id', id: args.id } } : undefined
  )
}
function mode() {
  return store.getState().unifiedTabsByWorktree[WORKSPACE][0].viewMode
}

it('keeps a fresh launch in Terminal until a real CLI association reaches the production status path', () => {
  associate()
  expect(mode()).toBeUndefined()
  associate({ id: 'actual-cli-conversation', at: 20 })
  expect(mode()).toBe('chat')
  expect(store.getState().tabsByWorktree[WORKSPACE][0].viewMode).toBe('chat')
})

it.each(['terminal', 'chat'] as const)(
  'keeps the explicit %s choice during delayed identity and restore',
  (choice) => {
    store.getState().setTabViewMode(TAB, choice)
    associate({ id: 'restored-cli', restored: true })
    associate({ id: 'actual-cli-conversation', at: 20 })
    expect(mode()).toBe(choice)
  }
)

it('does not treat restored identity or an IDE/reference session key as a fresh CLI association', () => {
  associate({ id: 'restored-cli', restored: true })
  expect(mode()).toBeUndefined()
  associate({ id: 'ide-reference-id', key: 'session_id', at: 20 })
  expect(mode()).toBeUndefined()
})

it('does not apply a stale association after a newer unassociated turn', () => {
  associate({ at: 30 })
  associate({ id: 'old-cli-conversation', at: 20 })
  expect(mode()).toBeUndefined()
})

it('keeps a direct SSH association in Terminal', () => {
  associate({ id: 'remote-cli', connectionId: 'ssh-unverifiable' })
  expect(mode()).toBeUndefined()
})

it.each(['wsl:Debian', 'runtime-ssh-fixture-host'])(
  'retains the existing transcript transport for %s associations',
  (connectionId) => {
    associate({ id: 'host-owned-cli', connectionId })
    expect(mode()).toBe('chat')
  }
)

it('does not apply the preference to an arbitrary terminal that merely runs Antigravity', () => {
  store.setState({ tabsByWorktree: { [WORKSPACE]: [makeTab({ id: TAB, worktreeId: WORKSPACE })] } })
  associate({ id: 'typed-cli' })
  expect(mode()).toBeUndefined()
})

it('keeps the preference disabled when the setting is off', () => {
  const settings = store.getState().settings
  if (!settings) {
    throw new Error('Settings missing')
  }
  store.setState({ settings: { ...settings, openAgentTabsInChatByDefault: false } })
  associate({ id: 'actual-cli-conversation' })
  expect(mode()).toBeUndefined()
})
