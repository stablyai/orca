import { describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from '../../testing/app-store-test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/bot-catalog-snapshot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readBots: () => [
    { id: 'bot-1', hostId: 'local', folderWorkspaceId: 'bot-home', chatSessionId: 'home' }
  ]
}))

createTabsSliceMockApi()

const BOT_PAGE = 'folder:bot-home'

function pinned(store: ReturnType<typeof createTestStore>, tabId: string): boolean {
  return Object.values(store.getState().unifiedTabsByWorktree)
    .flat()
    .some((tab) => tab.id === tabId && tab.isPinned === true)
}

describe('pinning on a bot page', () => {
  it("refuses a bot's side chat but still pins its other tabs and chats elsewhere", () => {
    const store = createTestStore()
    const state = store.getState()
    state.createUnifiedTab(BOT_PAGE, 'agent-session', {
      id: 'side',
      entityId: 'side-session',
      executionHostId: 'local',
      agentSessionAgent: 'claude',
      label: 'Side'
    })
    state.createUnifiedTab(BOT_PAGE, 'browser', { id: 'page', entityId: 'page', label: 'Docs' })
    state.createUnifiedTab('folder:elsewhere', 'agent-session', {
      id: 'other-chat',
      entityId: 'other-session',
      agentSessionAgent: 'claude',
      label: 'Other'
    })

    store.getState().pinTab('side')
    store.getState().pinTab('page')
    store.getState().pinTab('other-chat')

    expect(pinned(store, 'side')).toBe(false)
    expect(pinned(store, 'page')).toBe(true)
    expect(pinned(store, 'other-chat')).toBe(true)
  })

  it('keeps paired and SSH chat pinning unchanged even in a workspace with the same id', () => {
    const store = createTestStore()
    store.getState().createUnifiedTab(BOT_PAGE, 'agent-session', {
      id: 'paired',
      entityId: 'side-session',
      executionHostId: 'runtime:paired',
      label: 'Side'
    })
    store.getState().createUnifiedTab(BOT_PAGE, 'agent-session', {
      id: 'ssh',
      entityId: 'side-session',
      executionHostId: 'ssh:server',
      label: 'Side'
    })
    store.getState().createUnifiedTab(BOT_PAGE, 'agent-session', {
      id: 'unknown-owner',
      entityId: 'side-session',
      label: 'Side'
    })
    store.getState().pinTab('paired')
    store.getState().pinTab('ssh')
    store.getState().pinTab('unknown-owner')
    expect(pinned(store, 'paired')).toBe(true)
    expect(pinned(store, 'ssh')).toBe(true)
    expect(pinned(store, 'unknown-owner')).toBe(true)
  })
})
