import { describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/settings/global-settings-test-fixture'
import { buildSplitNode } from '../../../../shared/workspace-layout/tab-groups/tab-group-layout-tree'
import { createTabsSliceMockApi } from './tabs/tabs-slice-test-harness'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeTabGroup } from './tabs/tab-group.test-fixture'
import { normalizeWorktreeChatSide } from './tabs/chat-panel-layout'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createTabsSliceMockApi()

const WORKTREE = 'folder:project'
const CHAT_GROUP = 'group-chat'
const CONTENT_GROUP = 'group-content'

function modeStore(workspaceMode: 'work' | 'code') {
  const store = createTestStore()
  seedStore(store, {
    activeWorktreeId: WORKTREE,
    settings: createGlobalSettingsFixture({ workspaceMode })
  })
  const chat = store.getState().createUnifiedTab(WORKTREE, 'agent-session', {
    id: 'chat-1',
    entityId: 'session-1',
    agentSessionAgent: 'codex',
    executionHostId: 'local'
  })
  return { store, chat }
}

function chatGroups() {
  return [
    makeTabGroup({
      id: CHAT_GROUP,
      worktreeId: WORKTREE,
      isChatPanel: true,
      activeTabId: 'chat-1',
      tabOrder: ['chat-1']
    }),
    makeTabGroup({
      id: CONTENT_GROUP,
      worktreeId: WORKTREE,
      activeTabId: 'file-1',
      tabOrder: ['file-1']
    })
  ]
}

describe('code mode chat-right', () => {
  it('splits a new file left of the chat column', () => {
    const { store, chat } = modeStore('code')
    const file = store.getState().createUnifiedTab(WORKTREE, 'editor', { id: 'file-a' })
    expect(file.groupId).not.toBe(chat.groupId)
    expect(store.getState().layoutByWorktree[WORKTREE]).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { groupId: file.groupId },
      second: { groupId: chat.groupId }
    })
  })

  it('flips a legacy chat-left split when a file opens', () => {
    const { store, chat } = modeStore('code')
    const file = store.getState().createUnifiedTab(WORKTREE, 'editor', { id: 'file-a' })
    store.setState((state) => ({
      layoutByWorktree: {
        ...state.layoutByWorktree,
        [WORKTREE]: buildSplitNode(file.groupId, chat.groupId, 'horizontal', 'first')
      }
    }))
    const second = store.getState().createUnifiedTab(WORKTREE, 'editor', { id: 'file-b' })
    expect(second.groupId).toBe(file.groupId)
    expect(store.getState().layoutByWorktree[WORKTREE]).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { groupId: file.groupId },
      second: { groupId: chat.groupId }
    })
  })

  it('mirrors the divider ratio when flipping and spares vertical splits', () => {
    const horizontal = {
      ...buildSplitNode(CONTENT_GROUP, CHAT_GROUP, 'horizontal', 'first'),
      ratio: 0.3
    }
    expect(normalizeWorktreeChatSide(horizontal, chatGroups(), 'code')).toMatchObject({
      first: { groupId: CONTENT_GROUP },
      second: { groupId: CHAT_GROUP },
      ratio: 0.7
    })
    const vertical = {
      ...buildSplitNode(CONTENT_GROUP, CHAT_GROUP, 'vertical', 'first'),
      ratio: 0.3
    }
    expect(normalizeWorktreeChatSide(vertical, chatGroups(), 'code')).toMatchObject({
      first: { groupId: CHAT_GROUP },
      second: { groupId: CONTENT_GROUP },
      ratio: 0.3
    })
  })

  it('keeps chat left in work mode', () => {
    const { store, chat } = modeStore('work')
    const file = store.getState().createUnifiedTab(WORKTREE, 'editor', { id: 'file-a' })
    expect(store.getState().layoutByWorktree[WORKTREE]).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { groupId: chat.groupId },
      second: { groupId: file.groupId }
    })
  })
})
