import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorStore, createEditorTabsStore } from './editor-slice-test-harness'
import type { AppState } from '../types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

describe('createEditorSlice floating editor activation', () => {
  it('creates a visible floating editor tab when the floating workspace is empty', () => {
    const store = createEditorTabsStore()

    store.getState().openFile(
      {
        filePath: '/tmp/orca/notes.md',
        relativePath: 'notes.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    const tab = store.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(tab).toMatchObject({
      contentType: 'editor',
      entityId: '/tmp/orca/notes.md',
      label: 'notes.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })
    expect(store.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]).toMatchObject({
      activeTabId: tab?.id,
      tabOrder: [tab?.id]
    })
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      '/tmp/orca/notes.md'
    )
  })

  it('opens floating markdown tabs without changing the main active editor surface', () => {
    const store = createEditorStore()
    store.setState({
      activeFileId: '/repo/main.md',
      activeTabType: 'editor',
      activeFileIdByWorktree: { 'wt-1': '/repo/main.md' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' }
    } as Partial<AppState>)

    store.getState().openFile({
      filePath: '/tmp/orca/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    expect(store.getState().activeFileId).toBe('/repo/main.md')
    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      '/tmp/orca/untitled.md'
    )
    expect(store.getState().activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('editor')
  })

  it('opens same-path floating markdown as a separate owner-qualified tab', () => {
    const store = createEditorStore()
    store.setState({
      openFiles: [
        {
          id: '/repo/README.md',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        }
      ],
      activeFileIdByWorktree: { 'wt-1': '/repo/README.md' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' }
    } as Partial<AppState>)

    store.getState().openFile(
      {
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    expect(store.getState().openFiles).toHaveLength(2)
    expect(store.getState().openFiles[0]).toMatchObject({
      filePath: '/repo/README.md',
      worktreeId: 'wt-1'
    })
    expect(store.getState().openFiles[1]).toMatchObject({
      filePath: '/repo/README.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null
    })
    expect(store.getState().openFiles[1]?.id).not.toBe('/repo/README.md')
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      store.getState().openFiles[1]?.id
    )
  })
})

describe('createEditorSlice split-group editor routing', () => {
  function openSourceFile(
    store: StoreApi<AppState>,
    filePath: string,
    options?: Parameters<AppState['openFile']>[1]
  ): void {
    store.getState().openFile(
      {
        filePath,
        relativePath: filePath.replace('/repo/', ''),
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      options
    )
  }

  function seedTerminalAndEditorGroups(store: StoreApi<AppState>): {
    terminalTabId: string
    terminalGroupId: string
    editorGroupId: string
  } {
    const terminalTab = store.getState().createUnifiedTab('wt-1', 'terminal', {
      id: 'terminal-tab',
      entityId: 'terminal-tab',
      label: 'Agent'
    })
    const terminalGroup = store.getState().groupsByWorktree['wt-1']?.[0]
    if (!terminalGroup) {
      throw new Error('Expected terminal group')
    }
    const terminalGroupId = terminalGroup.id
    const editorGroupId = store.getState().createEmptySplitGroup('wt-1', terminalGroupId, 'right')
    if (!editorGroupId) {
      throw new Error('Expected split editor group')
    }
    openSourceFile(store, '/repo/seed.ts', { targetGroupId: editorGroupId })
    store.setState({
      activeGroupIdByWorktree: { 'wt-1': terminalGroupId },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { 'wt-1': 'terminal' }
    } as Partial<AppState>)
    return { terminalTabId: terminalTab.id, terminalGroupId, editorGroupId }
  }

  function findUnifiedTabByEntity(store: StoreApi<AppState>, entityId: string) {
    return store.getState().unifiedTabsByWorktree['wt-1']?.find((tab) => tab.entityId === entityId)
  }

  it('routes implicit file opens to an existing visible editor group', () => {
    const store = createEditorTabsStore()
    const { terminalTabId, terminalGroupId, editorGroupId } = seedTerminalAndEditorGroups(store)

    openSourceFile(store, '/repo/next.ts')

    const openedTab = findUnifiedTabByEntity(store, '/repo/next.ts')
    const terminalGroup = store
      .getState()
      .groupsByWorktree['wt-1'].find((group) => group.id === terminalGroupId)
    const editorGroup = store
      .getState()
      .groupsByWorktree['wt-1'].find((group) => group.id === editorGroupId)
    expect(openedTab?.groupId).toBe(editorGroupId)
    expect(editorGroup?.activeTabId).toBe(openedTab?.id)
    expect(terminalGroup?.activeTabId).toBe(terminalTabId)
  })

  it('uses editor-recent groups when no inactive group is currently showing an editor', () => {
    const store = createEditorTabsStore()
    const { editorGroupId } = seedTerminalAndEditorGroups(store)
    store.getState().createUnifiedTab('wt-1', 'browser', {
      id: 'browser-tab',
      entityId: 'browser-tab',
      label: 'Browser',
      targetGroupId: editorGroupId
    })

    openSourceFile(store, '/repo/recent-target.ts')

    expect(findUnifiedTabByEntity(store, '/repo/recent-target.ts')?.groupId).toBe(editorGroupId)
  })

  it('keeps explicit target groups ahead of default editor routing', () => {
    const store = createEditorTabsStore()
    const { terminalGroupId } = seedTerminalAndEditorGroups(store)

    openSourceFile(store, '/repo/explicit.ts', { targetGroupId: terminalGroupId })

    expect(findUnifiedTabByEntity(store, '/repo/explicit.ts')?.groupId).toBe(terminalGroupId)
  })

  it('opens implicit files in a focused browser split group instead of stealing an editor pane (#6891)', () => {
    const store = createEditorTabsStore()
    const { editorGroupId } = seedTerminalAndEditorGroups(store)

    // Regression #6891: with a split like Agent | Browser, focusing the browser
    // pane and opening a file sent it to another pane. A focused browser pane
    // was treated like a focused agent terminal, so the open was stolen into an
    // existing editor pane instead of the focused group.
    const browserGroupId = store.getState().createEmptySplitGroup('wt-1', editorGroupId, 'right')
    if (!browserGroupId) {
      throw new Error('Expected split browser group')
    }
    store.getState().createUnifiedTab('wt-1', 'browser', {
      id: 'browser-tab',
      entityId: 'browser-tab',
      label: 'Browser',
      targetGroupId: browserGroupId
    })
    store.setState({
      activeGroupIdByWorktree: { 'wt-1': browserGroupId },
      activeTabType: 'browser',
      activeTabTypeByWorktree: { 'wt-1': 'browser' }
    } as Partial<AppState>)

    openSourceFile(store, '/repo/from-browser.ts')

    expect(findUnifiedTabByEntity(store, '/repo/from-browser.ts')?.groupId).toBe(browserGroupId)
  })
})
