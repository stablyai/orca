// Exercise draft preservation, self-write echoes, autosave suspension and baseline settlement through the headless controller.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests, recordSelfWrite } from './editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindow,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from './editor-autosave-controller-test-fixture'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'

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

  it('preserves dirty drafts and marks the tab changed-on-disk on external file change', () => {
    stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store)

    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      dispatchExternalChange()

      const file = store.getState().openFiles[0]
      expect(file?.isDirty).toBe(true)
      expect(file?.externalMutation).toBe('changed')
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('unsaved edit')
    } finally {
      cleanup()
    }
  })

  it('clears drafts and a stale changed-on-disk mark for clean tabs on external file change', () => {
    stubEditorWindow()
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setExternalMutation('/repo/file.ts', 'changed')

    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      dispatchExternalChange()

      const file = store.getState().openFiles[0]
      expect(file?.isDirty).toBe(false)
      expect(file?.externalMutation).toBeUndefined()
    } finally {
      cleanup()
    }
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

  it('suspends autosave while a tab is marked changed-on-disk and resumes when cleared', async () => {
    const writeFile = stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store, 'user edit')
    store.getState().setExternalMutation('/repo/file.ts', 'changed')

    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      await vi.advanceTimersByTimeAsync(1500)
      expect(writeFile).not.toHaveBeenCalled()

      store.getState().setExternalMutation('/repo/file.ts', null)
      await vi.advanceTimersByTimeAsync(1500)
      expect(writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/repo/file.ts',
          content: 'user edit',
          connectionId: undefined,
          expectedExecutionHostId: 'local'
        })
      )
    } finally {
      cleanup()
    }
  })

  describe('a restored draft autosaves through the guarded write alone', () => {
    // Why: hydration restores the draft with the persisted baseline; nothing pauses its autosave.
    function restore(disk: string) {
      const fakeDisk = stubEditorWindowWithDisk(createFakeEditorDisk({ '/repo/file.ts': disk }))
      const store = createEditorStore()
      openDirtyFile(store, 'restored draft')
      store.getState().setLastKnownDiskSignature('/repo/file.ts', getDiskBaselineSignature('base'))
      return { fakeDisk, store, cleanup: attachEditorAutosaveController(store) }
    }

    it.each([
      ['disk still holds the baseline', 'base'],
      ['disk already holds the draft', 'restored draft']
    ])('lands and goes clean without a banner when %s', async (_label, disk) => {
      const { fakeDisk, store, cleanup } = restore(disk)
      try {
        await vi.advanceTimersByTimeAsync(1500)
        expect(fakeDisk.files.get('/repo/file.ts')).toBe('restored draft')
        expect(store.getState().openFiles[0]).toMatchObject({ isDirty: false })
        expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
      } finally {
        cleanup()
      }
    })

    it('is refused with the banner, keeps the draft and stops autosaving when disk changed', async () => {
      const { fakeDisk, store, cleanup } = restore('agent write')
      try {
        await vi.advanceTimersByTimeAsync(1500)
        expect(fakeDisk.files.get('/repo/file.ts')).toBe('agent write')
        expect(store.getState().openFiles[0]).toMatchObject({
          isDirty: true,
          externalMutation: 'changed'
        })
        expect(store.getState().editorDrafts['/repo/file.ts']).toBe('restored draft')

        await vi.advanceTimersByTimeAsync(5000)
        expect(fakeDisk.fs.writeFile).toHaveBeenCalledTimes(1)
      } finally {
        cleanup()
      }
    })
  })

  it("clears the changed-on-disk mark after the banner's Overwrite", async () => {
    const writeFile = stubEditorWindow()
    const store = createEditorStore()
    openDirtyFile(store, 'user version')
    store.getState().setExternalMutation('/repo/file.ts', 'changed')

    const cleanup = attachEditorAutosaveController(withLoadedBaselines(store))
    try {
      await requestEditorFileSave({ fileId: '/repo/file.ts', overwrite: true })

      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.ts',
        content: 'user version',
        connectionId: undefined,
        expectedExecutionHostId: 'local'
      })
      const file = store.getState().openFiles[0]
      expect(file?.isDirty).toBe(false)
      expect(file?.externalMutation).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})
