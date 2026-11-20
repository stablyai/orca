import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { buildSplitNode } from '../../../../../shared/workspace-layout/tab-groups/tab-group-layout-tree'
import { createGlobalSettingsFixture } from '../../../../../shared/settings/global-settings-test-fixture'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeTabGroup, makeUnifiedTab } from './tab-group.test-fixture'
import { shouldPinChatPanelColumn } from './chat-panel-layout'

const mocks = vi.hoisted(() => ({ beginClose: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: mocks.beginClose
}))

// `repoId::path` names both checkouts: this machine's and the paired server's.
const WORKTREE = 'repo-1::/work/app'
const CHAT_GROUP = 'group-chat'
const CONTENT_GROUP = 'group-content'

function chatTab(id: string, groupId: string): Tab {
  return makeUnifiedTab({
    id,
    entityId: id,
    groupId,
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    agentSessionAgent: 'codex'
  })
}

function contentTab(): Tab {
  return makeUnifiedTab({
    id: 'terminal:1',
    groupId: CONTENT_GROUP,
    worktreeId: WORKTREE,
    contentType: 'terminal'
  })
}

function storeWithChatColumn(settings: {
  toolsSidebarPosition: 'left' | 'right'
  workspaceMode?: 'work' | 'code'
}): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const chat = chatTab('agent-session:chat-1', CHAT_GROUP)
  seedStore(store, {
    // Why: seedStore takes full GlobalSettings, so layer the position over the shared fixture.
    settings: createGlobalSettingsFixture({ ...settings }),
    activeWorktreeId: WORKTREE,
    unifiedTabsByWorktree: { [WORKTREE]: [chat, contentTab()] },
    groupsByWorktree: {
      [WORKTREE]: [
        makeTabGroup({
          id: CHAT_GROUP,
          worktreeId: WORKTREE,
          isChatPanel: true,
          activeTabId: chat.id,
          tabOrder: [chat.id]
        }),
        makeTabGroup({
          id: CONTENT_GROUP,
          worktreeId: WORKTREE,
          activeTabId: 'terminal:1',
          tabOrder: ['terminal:1']
        })
      ]
    },
    layoutByWorktree: {
      [WORKTREE]: buildSplitNode(CONTENT_GROUP, CHAT_GROUP, 'horizontal', 'second')
    },
    activeGroupIdByWorktree: { [WORKTREE]: CHAT_GROUP }
  })
  return store
}

beforeEach(() => {
  mocks.beginClose.mockReset()
})

describe('shouldPinChatPanelColumn', () => {
  it('never pins the chat column so its last chat can close or move', () => {
    expect(shouldPinChatPanelColumn()).toBe(false)
  })
})

describe('unpinned chat column tab close', () => {
  it('closes the last chat and collapses the split', () => {
    const store = storeWithChatColumn({ toolsSidebarPosition: 'right' })

    const result = store.getState().closeUnifiedTab('agent-session:chat-1')

    expect(result).not.toBeNull()
    expect(store.getState().unifiedTabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      'terminal:1'
    ])
    expect(store.getState().groupsByWorktree[WORKTREE]?.map((group) => group.id)).toEqual([
      CONTENT_GROUP
    ])
  })
})

describe('unpinned chat column tab move', () => {
  it('lets the last chat move out and collapses the split', () => {
    const store = storeWithChatColumn({ toolsSidebarPosition: 'right' })

    const moved = store.getState().moveUnifiedTabToGroup('agent-session:chat-1', CONTENT_GROUP)

    expect(moved).toBe(true)
    expect(store.getState().groupsByWorktree[WORKTREE]?.map((group) => group.id)).toEqual([
      CONTENT_GROUP
    ])
  })
})
