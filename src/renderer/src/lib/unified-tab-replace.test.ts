import { beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

// The real store: a replace must close the chat as layout only, never as a user's close of its conversation.

const rpc = vi.hoisted(() => ({
  closeSession: vi.fn(() => Promise.resolve()),
  call: vi.fn(() => Promise.resolve({ ok: true }))
}))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: rpc.closeSession
}))
vi.mock('@/runtime/runtime-rpc-client', async (actual) => ({
  ...(await actual<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: rpc.call
}))

const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
createTabsSliceMockApi()
const { createTestStore, makeTab, makeTabGroup, makeUnifiedTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

const { replaceUnifiedTab } = await import('./unified-tab-anchor-insertion')

const WT = 'repo1::/tmp/wt1'
const GROUP = 'group-1'

function seed(pinnedChat: boolean): void {
  const pinned = makeUnifiedTab({
    id: 'u-pinned',
    entityId: 'pinned',
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    isPinned: true
  })
  const chat = makeUnifiedTab({
    id: 'chat-tab',
    entityId: 'session-1',
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'agent-session',
    executionHostId: 'local',
    isPinned: pinnedChat
  })
  const other = makeUnifiedTab({
    id: 'u-other',
    entityId: 'other',
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal'
  })
  const terminal = makeUnifiedTab({
    id: 'u-switched',
    entityId: 'switched',
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal'
  })
  seedStore(store, {
    activeWorktreeId: WT,
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/tmp/wt1' })] },
    tabsByWorktree: {
      [WT]: ['pinned', 'other', 'switched'].map((id) => makeTab({ id, worktreeId: WT }))
    },
    unifiedTabsByWorktree: { [WT]: [pinned, chat, other, terminal] },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({
          id: GROUP,
          worktreeId: WT,
          activeTabId: 'chat-tab',
          tabOrder: ['u-pinned', 'chat-tab', 'u-other', 'u-switched'],
          recentTabIds: ['chat-tab']
        })
      ]
    },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [WT]: GROUP },
    openFiles: [],
    browserTabsByWorktree: {}
  } as Partial<AppState>)
}

beforeEach(() => {
  rpc.closeSession.mockClear()
  rpc.call.mockClear()
})

it.each([false, true])(
  'takes the chat tab’s slot (pinned: %s) and sends no close for its conversation',
  (pinnedChat) => {
    seed(pinnedChat)
    expect(replaceUnifiedTab(WT, 'u-switched', 'chat-tab')).toBe(true)
    const state = store.getState()
    expect(state.groupsByWorktree[WT]?.[0]?.tabOrder).toEqual(['u-pinned', 'u-switched', 'u-other'])
    expect(
      state.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === 'u-switched')?.isPinned === true
    ).toBe(pinnedChat)
    expect(state.unifiedTabsByWorktree[WT]?.some((tab) => tab.id === 'chat-tab')).toBe(false)
    expect(rpc.closeSession).not.toHaveBeenCalled()
    expect(rpc.call).not.toHaveBeenCalled()
  }
)
