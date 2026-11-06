import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createBrowserMockApi } from './browser-slice-test-harness'
import './editor-slice-test-harness'
import { createTestStore as createAppStore, seedStore } from './store-test-helpers'
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
})
