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

  it('creates a permanent read-only edit tab', () => {
    const store = createEditorStore()
    openReadOnlyLog(store)

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        filePath: LOG_PATH,
        mode: 'edit',
        readOnly: true,
        liveTail: true,
        isPreview: undefined,
        runtimeEnvironmentId: null
      })
    )
  })

  it('bumps the reload nonce on repeated View Log of a clean read-only tab', () => {
    const store = createEditorStore()
    openReadOnlyLog(store)
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBeUndefined()

    openReadOnlyLog(store)
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBe(1)
  })

  it('keeps read-only sticky when the same path is opened writable (no silent upgrade)', () => {
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
    expect(store.getState().openFiles[0]?.readOnly).toBe(true)
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
    expect(restored?.pendingDiskBaselineVerification).toBeUndefined()
    expect(store.getState().editorDrafts[LOG_PATH]).toBeUndefined()
  })

  it('restores the SSH target that owns an external host file', () => {
    const store = createEditorStore()
    store.setState({
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1' }] },
      folderWorkspaces: []
    } as never)

    store.getState().hydrateEditorSession({
      openFilesByWorktree: {
        'wt-1': [
          {
            filePath: '/tmp/ssh-preview.png',
            relativePath: '/tmp/ssh-preview.png',
            worktreeId: 'wt-1',
            language: 'png',
            externalSshTargetId: 'ssh-1'
          }
        ]
      }
    } as never)

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({ externalSshTargetId: 'ssh-1' })
    )
  })
})
