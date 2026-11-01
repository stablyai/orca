import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'
import type { AppState } from '../types'

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

  it('restores editability when the same path is explicitly opened writable', () => {
    const store = createEditorStore()
    openReadOnlyLog(store)

    store.getState().openFile({
      filePath: LOG_PATH,
      relativePath: LOG_PATH,
      worktreeId: 'wt-1',
      language: 'jsonl',
      mode: 'edit',
      runtimeEnvironmentId: null
    })

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.readOnly).toBeUndefined()
    expect(store.getState().openFiles[0]?.liveTail).toBeUndefined()
  })

  it('never flips an existing writable tab to read-only on View Log', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: LOG_PATH,
      relativePath: LOG_PATH,
      worktreeId: 'wt-1',
      language: 'jsonl',
      mode: 'edit',
      runtimeEnvironmentId: null
    })

    openReadOnlyLog(store)

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.readOnly).toBeUndefined()
  })

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
})
