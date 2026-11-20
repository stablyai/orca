import { describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from './tabs/tabs-slice-test-harness'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace/persistence/workspace-session-unified-tabs'
import { parseWorkspaceSession } from '../../../../shared/workspace-session/workspace-session-schema'
import { buildHydratedTabState } from './tabs/tabs-hydration'
import { applyDefaultChatPanelLayout } from './tabs/chat-panel-layout'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createTabsSliceMockApi()

function chatStore(worktreeId = 'folder:project') {
  const store = createTestStore()
  seedStore(store, { activeWorktreeId: worktreeId })
  const chat = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
    id: 'chat-1',
    entityId: 'session-1',
    agentSessionAgent: 'claude',
    executionHostId: 'local'
  })
  return { store, chat, worktreeId }
}

describe('fixed chat panels', () => {
  it('keeps chats fixed when a terminal is created from the focused panel', () => {
    const { store, chat, worktreeId } = chatStore()
    const terminal = store.getState().createTab(worktreeId)
    const panel = store.getState().groupsByWorktree[worktreeId].find((group) => group.isChatPanel)
    expect(panel?.tabOrder).toEqual([chat.id])
    expect(store.getState().getTab(terminal.id)?.groupId).not.toBe(panel?.id)
    expect(store.getState().getActiveTab(worktreeId)?.id).toBe(terminal.id)
  })
  it.each(['folder:project', 'repo::/project'])(
    'keeps a chat visible while files open in %s',
    (id) => {
      const { store, chat, worktreeId } = chatStore(id)
      expect(store.getState().groupsByWorktree[worktreeId][0].isChatPanel).toBe(true)
      const first = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file-a' })
      expect(first.groupId).not.toBe(chat.groupId)
      expect(
        store.getState().groupsByWorktree[worktreeId].find((g) => g.isChatPanel)
      ).toMatchObject({
        id: chat.groupId,
        activeTabId: chat.id,
        tabOrder: [chat.id]
      })
      store.getState().focusGroup(worktreeId, chat.groupId)
      const second = store.getState().createUnifiedTab(worktreeId, 'diff', { id: 'file-b' })
      expect(second.groupId).toBe(first.groupId)
      expect(store.getState().layoutByWorktree[worktreeId]).toMatchObject({
        type: 'split',
        direction: 'horizontal',
        first: { groupId: chat.groupId },
        second: { groupId: first.groupId }
      })
    }
  )

  it.each([true, false])('separates a new chat from open files (activate=%s)', (activate) => {
    const store = createTestStore()
    const worktreeId = 'folder:project'
    seedStore(store, { activeWorktreeId: worktreeId })
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    const chat = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
      id: 'chat',
      entityId: 'remote-session',
      executionHostId: 'runtime:paired-host',
      activate
    })
    expect(chat.groupId).not.toBe(file.groupId)
    expect(chat.executionHostId).toBe('runtime:paired-host')
    expect(store.getState().activeGroupIdByWorktree[worktreeId]).toBe(
      activate ? chat.groupId : file.groupId
    )
    expect(store.getState().getTab(chat.id)).toEqual(chat)
    expect(store.getState().getActiveTab(worktreeId)?.id).toBe(activate ? chat.id : file.id)
  })

  it.each(['chat-1', 'file'])(
    'migrates legacy mixed groups while preserving focus on %s',
    (activeId) => {
      const { store, chat, worktreeId } = chatStore()
      const second = store
        .getState()
        .createUnifiedTab(worktreeId, 'agent-session', { id: 'chat-2' })
      const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
      const saved = buildPersistedUnifiedTabSessionData(store.getState())
      const restored = buildHydratedTabState(
        {
          activeRepoId: null,
          activeWorktreeId: worktreeId,
          activeTabId: null,
          tabsByWorktree: {},
          terminalLayoutsByTabId: {},
          ...saved,
          unifiedTabs: {
            [worktreeId]: [chat, file, second].map((tab, sortOrder) => ({
              ...tab,
              groupId: chat.groupId,
              sortOrder
            }))
          },
          tabGroups: {
            [worktreeId]: [
              {
                id: chat.groupId,
                worktreeId,
                tabOrder: [chat.id, file.id, second.id],
                activeTabId: activeId,
                recentTabIds: [second.id, chat.id, file.id, activeId]
              }
            ]
          },
          activeGroupIdByWorktree: { [worktreeId]: chat.groupId },
          tabGroupLayouts: { [worktreeId]: { type: 'leaf', groupId: chat.groupId } }
        },
        new Set([worktreeId])
      )
      const panel = restored.groupsByWorktree[worktreeId].find((group) => group.isChatPanel)
      expect(panel?.tabOrder).toEqual([chat.id, second.id])
      expect(restored.layoutByWorktree[worktreeId]).toMatchObject({
        type: 'split',
        direction: 'horizontal',
        first: { groupId: panel?.id },
        second: { groupId: chat.groupId }
      })
      expect(restored.activeGroupIdByWorktree[worktreeId]).toBe(
        activeId === file.id ? chat.groupId : panel?.id
      )
      expect(
        restored.unifiedTabsByWorktree[worktreeId].find((tab) => tab.id === chat.id)
      ).toMatchObject({ entityId: 'session-1', executionHostId: 'local' })
      expect(applyDefaultChatPanelLayout(restored, worktreeId)).toBe(restored)
    }
  )

  it('marks chats opened in an explicit split as fixed panels too', () => {
    const { store, chat, worktreeId } = chatStore()
    const split = store.getState().createUnifiedTabInSplit(worktreeId, 'agent-session', {
      sourceGroupId: chat.groupId,
      splitDirection: 'right'
    })
    expect(
      store.getState().groupsByWorktree[worktreeId].find((g) => g.id === split?.groupId)
    ).toMatchObject({ isChatPanel: true })
  })

  it('docks an existing chat without changing its session or losing open files', () => {
    const { store, chat, worktreeId } = chatStore()
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file-a' })
    store.getState().activateTab(chat.id)
    const moved = store.getState().getTab(chat.id)
    expect(moved).toMatchObject({ id: chat.id, entityId: 'session-1', executionHostId: 'local' })
    expect(moved?.groupId).not.toBe(file.groupId)
    expect(
      store.getState().groupsByWorktree[worktreeId].find((g) => g.id === file.groupId)?.activeTabId
    ).toBe(file.id)
  })

  it('opens real editor items outside the panel even when the caller targets it', () => {
    const { store, chat, worktreeId } = chatStore()
    store.getState().openFile(
      {
        filePath: '/project/first.ts',
        relativePath: 'first.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      },
      { targetGroupId: chat.groupId }
    )
    const editor = store
      .getState()
      .unifiedTabsByWorktree[worktreeId].find((t) => t.contentType === 'editor')
    expect(editor?.groupId).not.toBe(chat.groupId)
    store.getState().focusGroup(worktreeId, chat.groupId)
    store.getState().openFile({
      filePath: '/project/second.ts',
      relativePath: 'second.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[worktreeId].filter((t) => t.contentType === 'editor')
        .every((t) => t.groupId === editor?.groupId)
    ).toBe(true)
    expect(
      store.getState().groupsByWorktree[worktreeId].find((g) => g.isChatPanel)?.activeTabId
    ).toBe(chat.id)
  })

  it('recreates the file area after the last file closes', () => {
    const { store, chat, worktreeId } = chatStore()
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file-a' })
    store.getState().closeUnifiedTab(file.id)
    const next = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file-b' })
    expect(next.groupId).not.toBe(chat.groupId)
    expect(store.getState().getTab(chat.id)?.entityId).toBe('session-1')
  })

  it('switches chats within one fixed panel', () => {
    const { store, chat, worktreeId } = chatStore()
    const second = store
      .getState()
      .createUnifiedTab(worktreeId, 'agent-session', { id: 'chat-2', agentSessionAgent: 'codex' })
    expect(second.groupId).toBe(chat.groupId)
  })

  it('adds new chats to the panel while the file area has focus', () => {
    const { store, chat, worktreeId } = chatStore()
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    store.getState().focusGroup(worktreeId, file.groupId)
    const next = store
      .getState()
      .createUnifiedTab(worktreeId, 'agent-session', { id: 'chat-2', agentSessionAgent: 'codex' })
    expect(next.groupId).toBe(chat.groupId)
  })

  it('preserves the execution host when docking a paired-server chat', () => {
    const { store, chat, worktreeId } = chatStore()
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [worktreeId]: state.unifiedTabsByWorktree[worktreeId].map((tab) => ({
          ...tab,
          executionHostId: 'runtime:paired-host' as const
        }))
      }
    }))
    store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    expect(store.getState().getTab(chat.id)).toMatchObject({
      entityId: 'session-1',
      executionHostId: 'runtime:paired-host'
    })
  })

  it('does not let a file drag replace a fixed chat', () => {
    const { store, chat, worktreeId } = chatStore()
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    expect(store.getState().moveUnifiedTabToGroup(file.id, chat.groupId)).toBe(false)
    expect(store.getState().dropUnifiedTab(file.id, { groupId: chat.groupId })).toBe(false)
  })

  it('round-trips the fixed panel and its resized layout through session persistence', () => {
    const { store, chat, worktreeId } = chatStore()
    store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    store.getState().setTabGroupSplitRatio(worktreeId, '', 0.4)
    const saved = buildPersistedUnifiedTabSessionData(store.getState())
    const parsed = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: worktreeId,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...saved
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error('invalid session')
    }
    const restored = buildHydratedTabState(parsed.value, new Set([worktreeId]))
    expect(restored.groupsByWorktree[worktreeId].find((g) => g.isChatPanel)?.id).toBe(chat.groupId)
    expect(restored.layoutByWorktree[worktreeId]).toMatchObject({ ratio: 0.4 })
  })
})
