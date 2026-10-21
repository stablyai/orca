import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'

vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

const closeActions = ['closeFile', 'closeAllFiles'] as const
const workspaces = [
  { label: 'git worktree', id: 'wt-1' },
  { label: 'folder workspace', id: 'folder:folder-1' }
] as const

function openMarkdown(store: ReturnType<typeof createEditorTabsStore>, worktreeId: string) {
  return store.getState().openFile({
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    worktreeId,
    language: 'markdown',
    mode: 'edit'
  })
}

describe.each(workspaces)('editor close selection in a $label', ({ id: worktreeId }) => {
  it.each(closeActions)('%s reveals the surviving structured chat', (action) => {
    const store = createEditorTabsStore()
    store.setState({ activeWorktreeId: worktreeId })
    const chat = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
      entityId: 'session-1',
      agentSessionAgent: 'codex',
      label: 'Codex Chat'
    })
    const fileId = openMarkdown(store, worktreeId)

    if (action === 'closeFile') {
      store.getState().closeFile(fileId)
    } else {
      store.getState().openFile({
        filePath: '/repo/second.md',
        relativePath: 'second.md',
        worktreeId,
        language: 'markdown',
        mode: 'edit'
      })
      store.getState().closeAllFiles()
    }

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(worktreeId)
    expect(state.activeTabType).toBe('agent-session')
    expect(state.activeTabTypeByWorktree[worktreeId]).toBe('agent-session')
    expect(state.unifiedTabsByWorktree[worktreeId]).toEqual([chat])
    expect(state.groupsByWorktree[worktreeId][0].activeTabId).toBe(chat.id)
    expect(state.openFiles).toEqual([])
    expect(state.activeFileId).toBeNull()
  })

  it.each(closeActions)('%s returns to the welcome screen when no tab survives', (action) => {
    const store = createEditorTabsStore()
    store.setState({ activeWorktreeId: worktreeId })
    const fileId = openMarkdown(store, worktreeId)

    if (action === 'closeFile') {
      store.getState().closeFile(fileId)
    } else {
      store.getState().closeAllFiles()
    }

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().unifiedTabsByWorktree[worktreeId]).toEqual([])
  })
})

describe('editor close mixed tab history', () => {
  it.each(closeActions)('%s reveals the most recently used remaining chat', (action) => {
    const store = createEditorTabsStore()
    const first = store.getState().createUnifiedTab('wt-1', 'agent-session', {
      entityId: 'session-1',
      agentSessionAgent: 'codex'
    })
    const second = store.getState().createUnifiedTab('wt-1', 'agent-session', {
      entityId: 'session-2',
      agentSessionAgent: 'codex'
    })
    store.getState().activateTab(first.id)
    const fileId = openMarkdown(store, 'wt-1')

    if (action === 'closeFile') {
      store.getState().closeFile(fileId)
    } else {
      store.getState().closeAllFiles()
    }

    const state = store.getState()
    expect(state.activeWorktreeId).toBe('wt-1')
    expect(state.activeTabType).toBe('agent-session')
    expect(state.groupsByWorktree['wt-1'][0].activeTabId).toBe(first.id)
    expect(state.unifiedTabsByWorktree['wt-1'].map((tab) => tab.id)).toEqual([first.id, second.id])
  })

  it.each(closeActions)('%s ignores chats in another workspace', (action) => {
    const store = createEditorTabsStore()
    const otherChat = store.getState().createUnifiedTab('wt-2', 'agent-session', {
      entityId: 'session-2',
      agentSessionAgent: 'codex',
      activate: false
    })
    const fileId = openMarkdown(store, 'wt-1')

    if (action === 'closeFile') {
      store.getState().closeFile(fileId)
    } else {
      store.getState().closeAllFiles()
    }

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().unifiedTabsByWorktree['wt-2']).toEqual([otherChat])
  })
})
