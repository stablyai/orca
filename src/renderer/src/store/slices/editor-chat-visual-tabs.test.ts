import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { isMobilePublishableOpenFile } from '@/runtime/sync-runtime-graph/mobile-session-surfaces'
import { buildChatVisualTabId } from '@/components/native-chat/native-chat-visual-tab'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

const visual = {
  target: { kind: 'local' as const },
  sessionId: 'session-1',
  file: 'latency-7c1e.html',
  title: 'Latency by region'
}
const TAB_ID = 'wt-1::chat-visual::session-1::latency-7c1e.html'

function visualTabs(store: ReturnType<typeof createEditorTabsStore>) {
  return (store.getState().unifiedTabsByWorktree['wt-1'] ?? []).filter(
    (tab) => tab.contentType === 'chat-visual'
  )
}

describe('chat visual tabs', () => {
  it('opens a visual as its own tab and focuses that tab when opened again', () => {
    const store = createEditorTabsStore()

    store.getState().openChatVisualTab('wt-1', visual)
    store.getState().openFile({
      filePath: '/repo/other.ts',
      relativePath: 'other.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().openChatVisualTab('wt-1', visual)

    expect(store.getState().activeFileId).toBe(TAB_ID)
    expect(store.getState().openFiles.filter((file) => file.id === TAB_ID)).toEqual([
      expect.objectContaining({
        mode: 'chat-visual',
        relativePath: 'Latency by region',
        chatVisual: visual
      })
    ])
    expect(visualTabs(store)).toEqual([
      expect.objectContaining({ entityId: TAB_ID, label: 'Latency by region' })
    ])
  })

  it('closes cleanly and leaves nothing to reopen from a snapshot', () => {
    const store = createEditorTabsStore()
    store.getState().openChatVisualTab('wt-1', visual)

    store.getState().closeFile(TAB_ID)

    expect(store.getState().openFiles).toEqual([])
    expect(visualTabs(store)).toEqual([])
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('takes the newest title when the same visual is opened again', () => {
    const store = createEditorTabsStore()
    store.getState().openChatVisualTab('wt-1', visual)

    const retitled = { ...visual, title: 'Latency by region (p99)' }
    store.getState().openChatVisualTab('wt-1', retitled)

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: TAB_ID,
        relativePath: 'Latency by region (p99)',
        chatVisual: retitled
      })
    ])
    expect(visualTabs(store)).toEqual([
      expect.objectContaining({ label: 'Latency by region (p99)' })
    ])
  })

  it('focuses the visual in the split that holds it instead of adding one beside the chat', () => {
    const store = createEditorTabsStore()
    const chat = store
      .getState()
      .createUnifiedTab('wt-1', 'agent-session', { entityId: 'session-1', label: 'Chat' })
    const chatGroupId = chat.groupId
    store.getState().openChatVisualTab('wt-1', visual)
    const [visualTab] = visualTabs(store)
    store.getState().dropUnifiedTab(visualTab!.id, {
      groupId: chatGroupId,
      splitDirection: 'right'
    })
    const visualGroupId = visualTabs(store)[0]!.groupId
    expect(visualGroupId).not.toBe(chatGroupId)
    store.getState().focusGroup('wt-1', chatGroupId)
    store.getState().activateTab(chat.id)

    store.getState().openChatVisualTab('wt-1', visual)

    const state = store.getState()
    const groups = state.groupsByWorktree['wt-1'] ?? []
    expect(visualTabs(store)).toHaveLength(1)
    expect(state.activeGroupIdByWorktree['wt-1']).toBe(visualGroupId)
    expect(groups.find((group) => group.id === visualGroupId)?.activeTabId).toBe(visualTab!.id)
    expect(groups.find((group) => group.id === chatGroupId)?.activeTabId).toBe(chat.id)
  })

  it('leaves the main workspace selection alone when opened from the floating panel', () => {
    const store = createEditorTabsStore()
    store.setState({ activeTabType: 'terminal', activeFileId: null })
    const floatingTabId = buildChatVisualTabId(FLOATING_TERMINAL_WORKTREE_ID, visual)

    store.getState().openChatVisualTab(FLOATING_TERMINAL_WORKTREE_ID, visual)

    const state = store.getState()
    expect(state.activeTabType).toBe('terminal')
    expect(state.activeFileId).toBeNull()
    expect(state.activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(floatingTabId)
    expect(state.activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('editor')
  })

  it('is never saved with the session or published to paired clients', () => {
    const store = createEditorTabsStore()
    store.getState().openFile({
      filePath: '/repo/other.ts',
      relativePath: 'other.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().openChatVisualTab('wt-1', visual)
    const state = store.getState()

    const persisted = buildPersistedUnifiedTabSessionData(state)

    expect(persisted.unifiedTabs?.['wt-1']?.map((tab) => tab.contentType)).toEqual(['editor'])
    expect(persisted.tabGroups?.['wt-1']?.flatMap((group) => group.tabOrder)).toHaveLength(1)
    const visualFile = state.openFiles.find((file) => file.id === TAB_ID)
    expect(visualFile && isMobilePublishableOpenFile(visualFile)).toBe(false)
  })
})
