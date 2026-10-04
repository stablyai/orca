import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { launchAgentInNewTab } from './launch-agent-in-new-tab'
import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'
import * as draftDelivery from './agent-paste-draft'

const initialState = useAppStore.getState()
const WORKTREE = 'wt-1'
const CLI_ID = 'actual-native-cli-conversation'
const LEAF = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn(async () => {}) } } })
  useAppStore.setState({
    settings: {
      ...createGlobalSettingsFixture(),
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      agentStatusHooksEnabled: false,
      agentWorkspaceTrustEnabled: false
    },
    repos: [{ ...TEST_REPO, connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: WORKTREE, repoId: TEST_REPO.id })] },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    pendingStartupByTabId: {},
    tabBarOrderByWorktree: {},
    activeWorktreeId: WORKTREE,
    activeTabType: 'terminal'
  })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function viewMode(tabId: string, worktreeId = WORKTREE) {
  return useAppStore
    .getState()
    .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === tabId)?.viewMode
}

function associate(tabId: string, worktreeId = WORKTREE) {
  useAppStore
    .getState()
    .setAgentStatus(
      makePaneKey(tabId, LEAF),
      { agentType: 'antigravity', state: 'waiting', prompt: '' },
      'Antigravity',
      { updatedAt: 20, stateStartedAt: 20 },
      { tabId, worktreeId, connectionId: null },
      { providerSession: { key: 'conversation_id', id: CLI_ID } }
    )
}

it('launches without a fabricated conversation and applies the preference after host association', () => {
  const result = launchAgentInNewTab({ agent: 'antigravity', worktreeId: WORKTREE })
  if (result?.surface.kind !== 'local-terminal') {
    throw new Error('Expected terminal launch')
  }
  const tabId = result.surface.tabId
  const startup = useAppStore.getState().pendingStartupByTabId[tabId]
  expect(viewMode(tabId)).toBeUndefined()
  expect(startup?.resumeProviderSession).toBeUndefined()
  expect(startup?.launchAgent).toBe('antigravity')
  associate(tabId)
  expect(viewMode(tabId)).toBe('chat')
})

it('keeps an explicit Terminal choice made between launch and association', () => {
  const result = launchAgentInNewTab({ agent: 'antigravity', worktreeId: WORKTREE })
  if (result?.surface.kind !== 'local-terminal') {
    throw new Error('Expected terminal launch')
  }
  useAppStore.getState().setTabViewMode(result.surface.tabId, 'terminal')
  associate(result.surface.tabId)
  expect(viewMode(result.surface.tabId)).toBe('terminal')
})

it('retains an unsent draft that the Chat composer cannot mirror in Terminal after association', () => {
  const paste = vi.spyOn(draftDelivery, 'pasteDraftWhenAgentReady').mockResolvedValue(true)
  const result = launchAgentInNewTab({
    agent: 'antigravity',
    worktreeId: WORKTREE,
    prompt: 'first\u2028second',
    promptDelivery: 'draft'
  })
  if (result?.surface.kind !== 'local-terminal') {
    throw new Error('Expected draft terminal launch')
  }
  expect(viewMode(result.surface.tabId)).toBe('terminal')
  associate(result.surface.tabId)
  expect(viewMode(result.surface.tabId)).toBe('terminal')
  expect(paste).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'first\u2028second', submit: false })
  )
})

it('uses the actual native CLI identity supplied by the AI Vault resume caller', () => {
  const providerSession = { key: 'conversation_id', id: CLI_ID } as const
  const result = launchAiVaultSessionInNewTab({
    agent: 'antigravity',
    worktreeId: WORKTREE,
    command: `antigravity --resume ${CLI_ID}`,
    providerSession
  })
  if (result.tabId === null) {
    throw new Error('Expected local resume')
  }
  expect(viewMode(result.tabId)).toBe('chat')
  expect(useAppStore.getState().pendingStartupByTabId[result.tabId]?.resumeProviderSession).toEqual(
    providerSession
  )
})

it.each([undefined, { key: 'session_id', id: 'ide-reference' } as const])(
  'keeps an AI Vault launch without a CLI conversation in Terminal',
  (providerSession) => {
    const result = launchAiVaultSessionInNewTab({
      agent: 'antigravity',
      worktreeId: WORKTREE,
      command: 'antigravity',
      providerSession
    })
    if (result.tabId === null) {
      throw new Error('Expected local launch')
    }
    expect(viewMode(result.tabId)).toBeUndefined()
  }
)

it('uses the sleeping CLI session identity while retaining background resume and claim behavior', () => {
  const record: SleepingAgentSessionRecord = {
    paneKey: makePaneKey('old-tab', LEAF),
    tabId: 'old-tab',
    worktreeId: WORKTREE,
    agent: 'antigravity',
    providerSession: { key: 'conversation_id', id: CLI_ID },
    prompt: '',
    state: 'waiting',
    origin: 'quit',
    capturedAt: 1,
    updatedAt: 1
  }
  useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [record.paneKey]: record } })
  expect(launchSleepingAgentSession(record, { suppressNavigation: true })).toBe(true)
  const tab = useAppStore.getState().tabsByWorktree[WORKTREE]?.[0]
  if (!tab) {
    throw new Error('Missing resume tab')
  }
  expect(viewMode(tab.id)).toBe('chat')
  expect(useAppStore.getState().pendingStartupByTabId[tab.id]?.resumeProviderSession).toEqual(
    record.providerSession
  )
  expect(useAppStore.getState().pendingStartupByTabId[tab.id]?.showSessionRestoredBanner).toBe(true)
  expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  expect(useAppStore.getState().activeTabId).toBe(initialState.activeTabId)
})

it('keeps a direct SSH resume in Terminal even with a known conversation', () => {
  useAppStore.setState({ repos: [{ ...TEST_REPO, connectionId: 'ssh-offline' }] })
  const result = launchAiVaultSessionInNewTab({
    agent: 'antigravity',
    worktreeId: WORKTREE,
    command: `antigravity --resume ${CLI_ID}`,
    providerSession: { key: 'conversation_id', id: CLI_ID }
  })
  if (result.tabId === null) {
    throw new Error('Expected direct SSH terminal')
  }
  expect(viewMode(result.tabId)).toBeUndefined()
})

it('applies delayed CLI association in a folder workspace without a git worktree', () => {
  const worktreeId = 'folder:fixture-folder'
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [
      {
        id: 'fixture-folder',
        projectGroupId: 'folder-group',
        name: 'Folder fixture',
        folderPath: '/private/fixture-folder',
        connectionId: null,
        executionHostId: 'local',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  const result = launchAgentInNewTab({ agent: 'antigravity', worktreeId })
  if (result?.surface.kind !== 'local-terminal') {
    throw new Error('Expected folder terminal launch')
  }
  expect(viewMode(result.surface.tabId, worktreeId)).toBeUndefined()
  associate(result.surface.tabId, worktreeId)
  expect(viewMode(result.surface.tabId, worktreeId)).toBe('chat')
})
