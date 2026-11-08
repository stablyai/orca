// Exercise draft preservation, self-write echoes, autosave suspension and baseline settlement through the headless controller.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  __clearSelfWriteRegistryForTests,
  recordSelfWrite
} from '../external-changes/editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindow,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from './editor-autosave-controller-test-fixture'
import { getDiskBaselineSignature } from '../../../../../shared/file-write/disk-baseline-signature'

const mocks = vi.hoisted(() => ({
  getConnectionIdForFile: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

function openDirtyFile(store: ReturnType<typeof createEditorStore>, draft = 'unsaved edit'): void {
  store.getState().openFile({
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setEditorDraft('/repo/file.ts', draft)
  store.getState().markFileDirty('/repo/file.ts', true)
}

function dispatchExternalChange(): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
      detail: { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'file.ts' }
    })
  )
}

describe('editor autosave changed-on-disk conflict flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('does not backstop-mark a dirty tab for the echo of its own save', () => {
    stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store, 'typed during save')
    // Combined-diff notifications bypass watcher echo checks; a fresh self-write stamp identifies the controller’s own save.
    recordSelfWrite('/repo/file.ts', 'orca save')

    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      dispatchExternalChange()

      const file = store.getState().openFiles[0]
      expect(file?.externalMutation).toBeUndefined()
      expect(file?.isDirty).toBe(true)
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('typed during save')
    } finally {
      cleanup()
    }
  })

  // A custom editor's Cmd+S reaches this same explicit save after flushing its frame.
  it('refuses an explicit save while the banner shows, keeping the edits and the disk', async () => {
    const fakeDisk = stubEditorWindowWithDisk(
      createFakeEditorDisk({ '/repo/file.ts': 'agent write' })
    )
    const store = createEditorStore()
    openDirtyFile(store, 'user stroke')
    store.getState().setLastKnownDiskSignature('/repo/file.ts', getDiskBaselineSignature('base'))
    store.getState().setExternalMutation('/repo/file.ts', 'changed')
    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: '/repo/file.ts' })).rejects.toThrow(
        'changed on disk'
      )
      expect(fakeDisk.files.get('/repo/file.ts')).toBe('agent write')
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('user stroke')
      expect(store.getState().openFiles[0]).toMatchObject({
        isDirty: true,
        externalMutation: 'changed'
      })
    } finally {
      cleanup()
    }
  })
})
