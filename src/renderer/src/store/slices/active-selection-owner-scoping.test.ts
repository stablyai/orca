import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createBrowserMockApi } from './browser-slice-test-harness'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { createTestStore as createAppStore, makeWorktree, seedStore } from './store-test-helpers'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'
import type { AppState } from '../types'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

vi.mock('@/runtime/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: vi.fn()
}))

// @ts-expect-error test window mock
globalThis.window = { api: createBrowserMockApi(vi.fn()) }

function openMarkdown(store: { getState: () => AppState }, worktreeId: string): string {
  store.getState().openFile({
    filePath: `/notes/${worktreeId}.md`,
    relativePath: `${worktreeId}.md`,
    worktreeId,
    runtimeEnvironmentId: null,
    language: 'markdown',
    mode: 'edit'
  })
  const file = store.getState().openFiles.find((entry) => entry.worktreeId === worktreeId)
  if (!file) {
    throw new Error(`no open file for ${worktreeId}`)
  }
  return file.id
}

function expectFloatingSelection(
  store: { getState: () => AppState },
  mainFileId: string,
  floatingFileId: string
): void {
  const state = store.getState()
  expect(state.activeFileId).toBe(mainFileId)
  expect(state.activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(floatingFileId)
  // The file's tab is activated in its own workspace's group, not the active one's.
  const floatingGroup = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
  const floatingTab = state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find(
    (tab) => tab.entityId === floatingFileId
  )
  expect(floatingTab).toBeDefined()
  expect(floatingGroup?.activeTabId).toBe(floatingTab?.id)
}

// Only active workspace projects global selection; visible floating-panel selection stays workspace-local.
describe('selection in a workspace other than the active one', () => {
  it('selects a created tab in its own workspace without moving the global tab', () => {
    const store = createAppStore()
    seedStore(store, {
      activeWorktreeId: 'repo1::/path/wt1',
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })]
      }
    })
    const mainTab = store.getState().createTab('repo1::/path/wt1')

    const floatingTab = store.getState().createTab(FLOATING_TERMINAL_WORKTREE_ID)

    const state = store.getState()
    expect(state.activeTabId).toBe(mainTab.id)
    expect(state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(floatingTab.id)
    const floatingGroup = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(
      state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find(
        (tab) => tab.id === floatingGroup?.activeTabId
      )?.entityId
    ).toBe(floatingTab.id)
  })

  it('records a file selection in its own workspace without moving the global file', async () => {
    const store = createAppStore()
    seedStore(store, { activeWorktreeId: 'wt-1' })
    const main = await drawTabsFromMain(store)
    try {
      const mainFileId = openMarkdown(store, 'wt-1')
      const floatingFileId = openMarkdown(store, FLOATING_TERMINAL_WORKTREE_ID)
      // Layout-owner frames must draw tabs before selection.
      await main.settle()
      store.getState().setActiveFile(mainFileId)

      store.getState().setActiveFile(floatingFileId)
      expectFloatingSelection(store, mainFileId, floatingFileId)
    } finally {
      main.close()
    }
  })

  it.each(['wt-2', FLOATING_TERMINAL_WORKTREE_ID])(
    'opens a file in %s without moving the global file or tab type',
    (worktreeId) => {
      const store = createEditorTabsStore()
      const mainFileId = openMarkdown(store, 'wt-1')
      store.setState({ activeTabType: 'terminal' })

      const fileId = openMarkdown(store, worktreeId)

      const state = store.getState()
      expect(state.activeFileId).toBe(mainFileId)
      expect(state.activeTabType).toBe('terminal')
      expect(state.activeFileIdByWorktree[worktreeId]).toBe(fileId)
      expect(state.activeTabTypeByWorktree[worktreeId]).toBe('editor')
    }
  )

  it('still moves the global file for the active workspace', () => {
    const store = createEditorTabsStore()
    const fileId = openMarkdown(store, 'wt-1')
    store.getState().setActiveFile(fileId)

    expect(store.getState().activeFileId).toBe(fileId)
  })

  it('records a browser selection in its own workspace without moving the global surface', async () => {
    const store = createAppStore()
    seedStore(store, { activeWorktreeId: 'wt-1' })
    // Layout-owner frames must draw tabs before selection.
    const main = await drawTabsFromMain(store)
    const mainTab = store.getState().createBrowserTab('wt-1', 'https://main.example.com')
    const floatingTab = store
      .getState()
      .createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, 'https://floating.example.com')
    await main.settle()
    main.close()
    store.getState().setActiveBrowserTab(mainTab.id)
    store.setState({ activeTabType: 'editor' })

    store.getState().setActiveBrowserTab(floatingTab.id)

    const state = store.getState()
    expect(state.activeBrowserTabId).toBe(mainTab.id)
    expect(state.activeTabType).toBe('editor')
    expect(state.activeBrowserTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(floatingTab.id)
    expect(state.activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('browser')
  })

  it('still moves the global browser surface for the active workspace', async () => {
    const store = createAppStore()
    seedStore(store, { activeWorktreeId: 'wt-1' })
    const main = await drawTabsFromMain(store)
    const tab = store.getState().createBrowserTab('wt-1', 'https://main.example.com')
    await main.settle()
    main.close()
    store.setState({ activeTabType: 'editor' })

    store.getState().setActiveBrowserTab(tab.id)

    expect(store.getState().activeBrowserTabId).toBe(tab.id)
    expect(store.getState().activeTabType).toBe('browser')
  })
})
