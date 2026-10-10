import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'

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

describe('createEditorSlice recently closed editor tabs', () => {
  it('reopens into the recorded group instead of opening a second pane', () => {
    // Why: Cmd+Shift+T returns a tab to where it was; it is replay, not a new pane.
    const store = createEditorTabsStore()
    const open = (filePath: string, options?: { placementFixed?: boolean }): string =>
      store.getState().openFile(
        {
          filePath,
          relativePath: filePath.split('/').pop() ?? filePath,
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit'
        },
        options
      )
    open('/repo/a.ts')
    const secondId = open('/repo/b.ts', { placementFixed: true })
    store.getState().closeFile(secondId)

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    const s = store.getState()
    expect(s.groupsByWorktree['wt-1']).toHaveLength(1)
    expect(s.layoutByWorktree['wt-1']?.type).toBe('leaf')
    expect(new Set((s.unifiedTabsByWorktree['wt-1'] ?? []).map((tab) => tab.groupId)).size).toBe(1)
  })

  it('restores the exact same-path owner instead of moving the local editor', () => {
    const store = createEditorTabsStore()
    const localId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    const remoteId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      runtimeEnvironmentId: 'env-1',
      mode: 'edit'
    })
    store.getState().setTabBarOrder('wt-1', [localId, remoteId])

    store.getState().closeFile(remoteId)
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    const openIds = store.getState().openFiles.map((file) => file.id)
    expect(openIds).toEqual([localId, remoteId])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([localId, remoteId])
  })

  it('keeps same-path edit and diff tabs as separate entities on reopen', () => {
    const store = createEditorTabsStore()
    const editId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openDiff('wt-1', '/repo/notes.md', 'notes.md', 'markdown', false)
    const diffId = 'wt-1::diff::unstaged::notes.md'
    store.getState().setTabBarOrder('wt-1', [editId, diffId])

    store.getState().closeFile(diffId)
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([editId, diffId])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([editId, diffId])
  })
})
