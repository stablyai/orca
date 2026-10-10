import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from '../editor-slice-test-harness'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
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
vi.mock('@/runtime/web-session-tabs-sync/closing/close-mirrored-editor-tab', () => ({
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
})
