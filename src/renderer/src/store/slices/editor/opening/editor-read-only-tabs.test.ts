import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from '../editor-slice-test-harness'
import type { AppState } from '../../../types'

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

describe('read-only editor tabs (AI Vault View Log)', () => {
  const LOG_PATH = '/home/user/.claude/sessions/log.jsonl'

  const openReadOnlyLog = (store: StoreApi<AppState>): void => {
    store.getState().openFile(
      {
        filePath: LOG_PATH,
        relativePath: LOG_PATH,
        worktreeId: 'wt-1',
        language: 'jsonl',
        mode: 'edit',
        readOnly: true,
        liveTail: true,
        runtimeEnvironmentId: null
      },
      { preview: false, forceContentReload: true, suppressActiveRuntimeFallback: true }
    )
  }

  it('markFileDirty and setEditorDraft hard no-op for read-only tabs', () => {
    const store = createEditorStore()
    openReadOnlyLog(store)

    store.getState().markFileDirty(LOG_PATH, true)
    store.getState().setEditorDraft(LOG_PATH, 'stray edit')

    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    expect(store.getState().editorDrafts[LOG_PATH]).toBeUndefined()
  })

  it('hydrates a persisted read-only tab clean and ignores any persisted dirty draft', () => {
    const store = createEditorStore()
    store.setState({
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1' }] },
      folderWorkspaces: []
    } as never)

    store.getState().hydrateEditorSession({
      openFilesByWorktree: {
        'wt-1': [
          {
            filePath: LOG_PATH,
            relativePath: LOG_PATH,
            worktreeId: 'wt-1',
            language: 'jsonl',
            readOnly: true,
            liveTail: true,
            // Why: a corrupt/legacy session could carry a draft; hydrate must
            // hard-strip it so the restored log can never come back writable.
            dirtyDraftContent: 'should be ignored',
            lastKnownDiskSignature: 'sig'
          }
        ]
      }
    } as never)

    const restored = store.getState().openFiles.find((f) => f.filePath === LOG_PATH)
    expect(restored).toEqual(
      expect.objectContaining({ readOnly: true, liveTail: true, isDirty: false, mode: 'edit' })
    )
    expect(store.getState().editorDrafts[LOG_PATH]).toBeUndefined()
  })

  describe('Explorer Host mode tabs', () => {
    const HOST_PATH = '/home/user/.bashrc'
    const openHostTab = (store: StoreApi<AppState>): void => {
      store.getState().openFile(
        {
          filePath: HOST_PATH,
          relativePath: HOST_PATH,
          worktreeId: 'wt-1',
          language: 'shell',
          mode: 'edit',
          readOnly: true,
          hostBrowse: true,
          runtimeEnvironmentId: null
        },
        { preview: true, forceContentReload: true, suppressActiveRuntimeFallback: true }
      )
    }
    const openWritable = (store: StoreApi<AppState>): void => {
      store.getState().openFile({
        filePath: HOST_PATH,
        relativePath: HOST_PATH,
        worktreeId: 'wt-1',
        language: 'shell',
        mode: 'edit',
        runtimeEnvironmentId: null
      })
    }

    it('only focuses an existing View Log tab without ending its live tail', () => {
      const store = createEditorStore()
      store.getState().openFile(
        {
          filePath: HOST_PATH,
          relativePath: HOST_PATH,
          worktreeId: 'wt-1',
          language: 'shell',
          mode: 'edit',
          readOnly: true,
          liveTail: true,
          runtimeEnvironmentId: null
        },
        { preview: false, forceContentReload: true, suppressActiveRuntimeFallback: true }
      )

      openHostTab(store)

      expect(store.getState().openFiles).toHaveLength(1)
      expect(store.getState().openFiles[0]).toEqual(
        expect.objectContaining({ readOnly: true, liveTail: true })
      )
      expect(store.getState().openFiles[0]?.hostBrowse).toBeUndefined()
    })

    it('drops the Host marker and captures owner provenance once opened writable', () => {
      const store = createEditorStore()
      openHostTab(store)
      expect(
        store.getState().openFiles[0]?.operationProvenance,
        'read-only Host tab carries no provenance'
      ).toBeUndefined()

      openWritable(store)

      const tab = store.getState().openFiles[0]
      expect(tab?.readOnly, 'tab is writable once reopened for edit').toBeUndefined()
      expect(tab?.hostBrowse, 'Host marker is dropped once opened writable').toBeUndefined()
      expect(
        tab?.operationProvenance,
        'provenance captured on the read-only -> writable transition'
      ).toBeDefined()
    })
  })
})
