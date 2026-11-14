import { describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { createEditorStore, createEditorTabsStore } from '../editor-slice-test-harness'
import { makeFolderWorkspace } from '../../../folder-workspaces/folder-workspace.test-fixture'

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

describe('createEditorSlice conflict status reconciliation', () => {
  it('preserves omitted conflict state when a capped result is incomplete', () => {
    const store = createEditorStore()
    const conflict = {
      path: 'src/conflict.ts',
      status: 'modified' as const,
      area: 'unstaged' as const,
      conflictKind: 'both_modified' as const,
      conflictStatus: 'unresolved' as const,
      conflictStatusSource: 'git' as const
    }
    store.getState().trackConflictPath('wt-huge', conflict.path, conflict.conflictKind)
    store.getState().openConflictFile('wt-huge', '/repo', conflict, 'typescript')
    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'merge',
      entries: [conflict]
    })

    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'unknown',
      entries: [{ path: 'generated/a.ts', status: 'untracked', area: 'untracked' }],
      didHitLimit: true,
      statusLength: 2
    })

    expect(store.getState().trackedConflictPathsByWorktree['wt-huge']).toEqual({
      'src/conflict.ts': 'both_modified'
    })
    expect(store.getState().gitConflictOperationByWorktree['wt-huge']).toBe('merge')
    expect(
      store.getState().openFiles.find((file) => file.relativePath === 'src/conflict.ts')?.conflict
    ).toMatchObject({
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved'
    })

    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'unknown',
      entries: []
    })

    expect(store.getState().trackedConflictPathsByWorktree['wt-huge']).toEqual({})
    expect(store.getState().gitConflictOperationByWorktree['wt-huge']).toBe('unknown')
  })

  describe('selecting a conflict whose file is already open', () => {
    const conflictEntry = {
      path: 'src/conflict.ts',
      status: 'modified',
      area: 'unstaged',
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved',
      conflictStatusSource: 'git'
    } as const
    const SERVER_WORKSPACE = folderWorkspaceKey('server-folder')
    const FILE = '/repo/src/conflict.ts'

    /** A folder workspace on paired server env-1, or a plain local worktree. */
    function storeFor(onServer: boolean) {
      const store = createEditorTabsStore()
      if (onServer) {
        store.setState({
          folderWorkspaces: [
            makeFolderWorkspace({
              id: 'server-folder',
              projectGroupId: 'server-group',
              folderPath: '/repo',
              connectionId: null
            })
          ],
          projectGroups: [
            {
              id: 'server-group',
              name: 'Server',
              parentPath: '/repo',
              connectionId: null,
              executionHostId: 'runtime:env-1',
              parentGroupId: null,
              createdFrom: 'folder-scan',
              tabOrder: 0,
              isCollapsed: false,
              color: null,
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      }
      return { store, worktreeId: onServer ? SERVER_WORKSPACE : 'wt-1' }
    }

    function selectConflict(store: ReturnType<typeof createEditorStore>, worktreeId: string) {
      store
        .getState()
        .openConflictReview(
          worktreeId,
          '/repo',
          [{ path: 'src/conflict.ts', conflictKind: 'both_modified' }],
          'live-summary'
        )
      store
        .getState()
        .openConflictReviewFile(
          store.getState().openFiles.find((file) => file.mode === 'conflict-review')!.id,
          worktreeId,
          '/repo',
          conflictEntry,
          'typescript'
        )
    }

    function openConflictFile(store: ReturnType<typeof createEditorStore>, worktreeId: string) {
      return store.getState().openFile({
        filePath: FILE,
        relativePath: 'src/conflict.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      })
    }

    const copiesOf = (store: ReturnType<typeof createEditorStore>) =>
      store
        .getState()
        .openFiles.filter((file) => file.filePath === FILE)
        .map((file) => [file.id, file.runtimeEnvironmentId ?? null])

    it('reuses an open server file instead of opening a second copy', () => {
      const { store, worktreeId } = storeFor(true)
      const fileId = openConflictFile(store, worktreeId)
      expect(fileId).not.toBe(FILE)

      selectConflict(store, worktreeId)

      expect(copiesOf(store)).toEqual([[fileId, 'env-1']])
      const state = store.getState()
      expect(state.openFiles.find((file) => file.id === fileId)?.conflict).toMatchObject({
        conflictStatus: 'unresolved'
      })
      expect(
        state.openFiles.find(
          (file) => file.mode === 'conflict-review' && file.worktreeId === worktreeId
        )?.conflictReview?.selectedFileId
      ).toBe(fileId)
    })
  })
})
