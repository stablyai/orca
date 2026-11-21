import { describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { pairedHostStatuses } from '@/lib/bot-host-capability.test-fixture'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/bot-catalog-snapshot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readBots: () => [
    { id: 'bot-1', hostId: 'local', folderWorkspaceId: 'bot-home', chatSessionId: 'home' },
    { id: 'bot-1', hostId: 'runtime:new', folderWorkspaceId: 'bot-home', chatSessionId: 'home' },
    { id: 'bot-1', hostId: 'runtime:old', folderWorkspaceId: 'bot-home', chatSessionId: 'home' }
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

  it('refuses side chats only on paired servers that keep the Home rule', () => {
    const store = createTestStore()
    store.setState({
      runtimeStatusByEnvironmentId: pairedHostStatuses({ new: ['bots.home-pin.v1'], old: [] })
    })
    const chat = (id: string, executionHostId?: ExecutionHostId) =>
      store.getState().createUnifiedTab(BOT_PAGE, 'agent-session', {
        id,
        entityId: 'side-session',
        ...(executionHostId ? { executionHostId } : {}),
        label: 'Side'
      })
    chat('new-server', 'runtime:new')
    chat('old-server', 'runtime:old')
    chat('ssh', 'ssh:server')
    chat('unknown-owner')
    for (const id of ['new-server', 'old-server', 'ssh', 'unknown-owner']) {
      store.getState().pinTab(id)
    }
    expect(pinned(store, 'new-server')).toBe(false)
    expect(pinned(store, 'old-server')).toBe(true)
    expect(pinned(store, 'ssh')).toBe(true)
    expect(pinned(store, 'unknown-owner')).toBe(true)
  })
})
