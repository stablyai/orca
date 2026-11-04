import { describe, expect, it, vi } from 'vitest'
import { createEditorStore, createEditorTabsStore } from './editor-slice-test-harness'
import { makeLayout, makeTab } from './store-test-helpers'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'

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

describe('createEditorSlice right sidebar state', () => {
  it('scopes the focus request to the unified tab that will render the file', async () => {
    const store = createEditorTabsStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'terminal-1', worktreeId: 'wt-1' })] },
      terminalLayoutsByTabId: { 'terminal-1': makeLayout() },
      // The session read-back main loads from reads these; this partial store lacks them.
      ptyIdsByTabId: {},
      lastKnownRelayPtyIdByTabId: {}
    })
    store.getState().createUnifiedTab('wt-1', 'terminal', { id: 'terminal-1' })
    const main = await drawTabsFromMain(store)
    const sourceTab = store.getState().unifiedTabsByWorktree['wt-1']![0]!
    const targetGroupId = store.getState().createEmptySplitGroup('wt-1', sourceTab.groupId, 'right')
    if (!targetGroupId) {
      throw new Error('expected split group')
    }

    store.getState().openFile(
      {
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { focusEditor: true, targetGroupId }
    )
    // A layout-owner build draws the tab, and asks for its focus, once main's frame is in.
    await main.settle()
    main.close()

    const editorTab = store
      .getState()
      .unifiedTabsByWorktree['wt-1']?.find((tab) => tab.contentType === 'editor')
    expect(editorTab?.groupId).toBe(targetGroupId)
    // Why: the pane matches the handoff on its own tab id, so a drifting id silently drops it.
    expect(store.getState().pendingEditorFocusRequest?.viewStateId).toBe(editorTab?.id)
  })

  it('collapses one directory subtree without touching sibling directories', () => {
    const store = createEditorStore()
    store.setState({
      expandedDirs: {
        'wt-1': new Set(['/repo/src', '/repo/src/components', '/repo/src2', '/repo/tests']),
        'wt-2': new Set(['/other/src'])
      }
    })

    store.getState().collapseDirSubtree('wt-1', '/repo/src')

    expect(store.getState().expandedDirs['wt-1']).toEqual(new Set(['/repo/src2', '/repo/tests']))
    expect(store.getState().expandedDirs['wt-2']).toEqual(new Set(['/other/src']))
  })
})
