import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  requestEditorFileSave,
  requestEditorSaveQuiesce,
  ORCA_EDITOR_FILE_SAVED_EVENT
} from './editor-autosave'
import { restoreMissingEditorFile } from './MissingEditorFileBanner'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk
} from './editor-autosave-controller-test-fixture'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

function openTestFile(store: ReturnType<typeof createEditorStore>, readOnly = false): void {
  store.getState().openFile({
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit',
    readOnly
  })
}

describe('autosave after a dirty file disappears', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getState.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(['deleted', 'renamed'] as const)(
    'does not recreate a %s path until an explicit save',
    async (mutation) => {
      const disk = createFakeEditorDisk({ '/repo/file.ts': 'original' })
      stubEditorWindowWithDisk(disk)
      const store = createEditorStore()
      openTestFile(store)
      const cleanup = attachEditorAutosaveController(store)
      try {
        store.getState().setEditorDraft('/repo/file.ts', 'unsaved draft')
        store.getState().markFileDirty('/repo/file.ts', true)
        disk.files.delete('/repo/file.ts')
        if (mutation === 'renamed') {
          disk.files.set('/repo/moved.ts', 'original')
        }
        store.getState().setExternalMutation('/repo/file.ts', mutation)
        await vi.advanceTimersByTimeAsync(2500)
        expect(disk.files.has('/repo/file.ts')).toBe(false)
        expect(store.getState().editorDrafts['/repo/file.ts']).toBe('unsaved draft')
        expect(store.getState().openFiles[0]?.isDirty).toBe(true)
        expect(store.getState().openFiles[0]?.externalMutation).toBe(mutation)
        mocks.getState.mockImplementation(store.getState)
        const file = store.getState().openFiles[0]
        if (!file) {
          throw new Error('Missing test tab')
        }
        await restoreMissingEditorFile(file)
        expect(disk.files.get('/repo/file.ts')).toBe('unsaved draft')
        expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
        if (mutation === 'renamed') {
          expect(disk.files.get('/repo/moved.ts')).toBe('original')
        }
      } finally {
        cleanup()
      }
    }
  )
  it('rejects a dirty missing draft, but leaves clean no-op saves unchanged', async () => {
    const disk = stubEditorWindowWithDisk()
    const store = createEditorStore()
    openTestFile(store)
    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: '/repo/file.ts' })).resolves.toBeUndefined()
      store.getState().markFileDirty('/repo/file.ts', true)
      await expect(requestEditorFileSave({ fileId: '/repo/file.ts' })).rejects.toThrow(
        'No editor content is available'
      )
      expect(disk.fs.writeFile).not.toHaveBeenCalled()
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('keeps a newer changed-on-disk conflict when the restore button had stale props', async () => {
    const disk = stubEditorWindowWithDisk()
    const store = createEditorStore()
    openTestFile(store)
    store.getState().setEditorDraft('/repo/file.ts', 'retained draft')
    store.getState().markFileDirty('/repo/file.ts', true)
    store.getState().setExternalMutation('/repo/file.ts', 'deleted')
    const staleFile = store.getState().openFiles[0]
    if (!staleFile) {
      throw new Error('Missing test tab')
    }
    store.getState().setExternalMutation('/repo/file.ts', 'changed')
    mocks.getState.mockImplementation(store.getState)
    const cleanup = attachEditorAutosaveController(store)
    try {
      await restoreMissingEditorFile(staleFile)
      expect(disk.fs.writeFile).not.toHaveBeenCalled()
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })

  it('keeps a read-only tab marked missing when Restore is requested', async () => {
    const disk = stubEditorWindowWithDisk()
    const store = createEditorStore()
    openTestFile(store, true)
    store.getState().setEditorDraft('/repo/file.ts', 'retained draft')
    store.getState().markFileDirty('/repo/file.ts', true)
    store.getState().setExternalMutation('/repo/file.ts', 'deleted')
    mocks.getState.mockImplementation(store.getState)
    const cleanup = attachEditorAutosaveController(store)
    try {
      const file = store.getState().openFiles[0]
      if (!file) {
        throw new Error('Missing test tab')
      }
      await restoreMissingEditorFile(file)
      expect(disk.fs.writeFile).not.toHaveBeenCalled()
      expect(store.getState().openFiles[0]?.externalMutation).toBe('deleted')
      expect(store.getState().editorDrafts['/repo/file.ts']).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it.each(['', 'retained content'])('restores a missing file with draft %j', async (draft) => {
    const disk = stubEditorWindowWithDisk()
    const store = createEditorStore()
    openTestFile(store)
    store.getState().setEditorDraft('/repo/file.ts', draft)
    store.getState().markFileDirty('/repo/file.ts', true)
    store.getState().setExternalMutation('/repo/file.ts', 'deleted')
    mocks.getState.mockImplementation(store.getState)
    const cleanup = attachEditorAutosaveController(store)
    try {
      const file = store.getState().openFiles[0]
      if (!file) {
        throw new Error('Missing test tab')
      }
      await restoreMissingEditorFile(file)
      expect(disk.files.get('/repo/file.ts')).toBe(draft)
      expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('keeps the missing mark when a queued Restore is canceled before writing', async () => {
    const disk = stubEditorWindowWithDisk()
    const gate = Promise.withResolvers<void>()
    disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        disk.files.set(filePath, content)
        await gate.promise
      }
    )
    const store = createEditorStore()
    openTestFile(store)
    store.getState().setEditorDraft('/repo/file.ts', 'earlier save')
    store.getState().markFileDirty('/repo/file.ts', true)
    mocks.getState.mockImplementation(store.getState)
    const cleanup = attachEditorAutosaveController(store)
    try {
      const earlierSave = requestEditorFileSave({ fileId: '/repo/file.ts' })
      await Promise.resolve()
      await Promise.resolve()
      expect(disk.files.has('/repo/file.ts')).toBe(true)
      disk.files.delete('/repo/file.ts')
      store.getState().setEditorDraft('/repo/file.ts', 'retained draft')
      store.getState().setExternalMutation('/repo/file.ts', 'deleted')
      const file = store.getState().openFiles[0]
      if (!file) {
        throw new Error('Missing test tab')
      }
      const restore = restoreMissingEditorFile(file)
      const quiesce = requestEditorSaveQuiesce({ fileId: '/repo/file.ts' })
      gate.resolve()
      await Promise.all([earlierSave, restore, quiesce])
      expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.has('/repo/file.ts')).toBe(false)
      expect(store.getState().openFiles[0]?.externalMutation).toBe('deleted')
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('retained draft')
    } finally {
      cleanup()
    }
  })

  it('does not treat a previous saved receipt as a queued Restore write', async () => {
    const disk = stubEditorWindowWithDisk()
    const gate = Promise.withResolvers<void>()
    disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        disk.files.set(filePath, content)
        await gate.promise
      }
    )
    const store = createEditorStore()
    openTestFile(store)
    store.getState().setEditorDraft('/repo/file.ts', 'earlier save')
    store.getState().markFileDirty('/repo/file.ts', true)
    mocks.getState.mockImplementation(store.getState)
    const cleanup = attachEditorAutosaveController(store)
    let quiesce: Promise<void> | undefined
    const deleteAfterSave = (): void => {
      disk.files.delete('/repo/file.ts')
      store.getState().setExternalMutation('/repo/file.ts', 'deleted')
      quiesce = requestEditorSaveQuiesce({ fileId: '/repo/file.ts' })
    }
    try {
      const earlierSave = requestEditorFileSave({ fileId: '/repo/file.ts' })
      await Promise.resolve()
      await Promise.resolve()
      store.getState().setEditorDraft('/repo/file.ts', 'retained draft')
      store.getState().setExternalMutation('/repo/file.ts', 'deleted')
      const file = store.getState().openFiles[0]
      if (!file) {
        throw new Error('Missing test tab')
      }
      const restore = restoreMissingEditorFile(file)
      window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, deleteAfterSave)
      gate.resolve()
      await Promise.all([earlierSave, restore])
      expect(quiesce).toBeDefined()
      await quiesce
      expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.has('/repo/file.ts')).toBe(false)
      expect(store.getState().openFiles[0]?.externalMutation).toBe('deleted')
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('retained draft')
    } finally {
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, deleteAfterSave)
      cleanup()
    }
  })

  it.each(['deleted', 'renamed'] as const)(
    'keeps a new %s mark during an earlier ordinary save',
    async (mutation) => {
      const disk = stubEditorWindowWithDisk()
      const gate = Promise.withResolvers<void>()
      disk.fs.writeFile.mockImplementationOnce(
        async ({ filePath, content }: { filePath: string; content: string }) => {
          disk.files.set(filePath, content)
          await gate.promise
        }
      )
      const store = createEditorStore()
      openTestFile(store)
      store.getState().setEditorDraft('/repo/file.ts', 'earlier save')
      store.getState().markFileDirty('/repo/file.ts', true)
      const cleanup = attachEditorAutosaveController(store)
      try {
        const save = requestEditorFileSave({ fileId: '/repo/file.ts' })
        await Promise.resolve()
        await Promise.resolve()
        disk.files.delete('/repo/file.ts')
        store.getState().setEditorDraft('/repo/file.ts', 'newer retained draft')
        store.getState().setExternalMutation('/repo/file.ts', mutation)
        gate.resolve()
        await save
        await vi.advanceTimersByTimeAsync(2500)
        expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
        expect(disk.files.has('/repo/file.ts')).toBe(false)
        expect(store.getState().openFiles[0]?.externalMutation).toBe(mutation)
        expect(store.getState().editorDrafts['/repo/file.ts']).toBe('newer retained draft')
        expect(store.getState().openFiles[0]?.isDirty).toBe(true)
      } finally {
        cleanup()
      }
    }
  )

  it('does not queue an autosave retry behind a pending restore that fails', async () => {
    const disk = stubEditorWindowWithDisk()
    const gate = Promise.withResolvers<void>()
    disk.fs.writeFile.mockImplementationOnce(async () => {
      await gate.promise
      throw new Error('write refused')
    })
    const store = createEditorStore()
    openTestFile(store)
    store.getState().setEditorDraft('/repo/file.ts', 'retained draft')
    store.getState().markFileDirty('/repo/file.ts', true)
    store.getState().setExternalMutation('/repo/file.ts', 'deleted')
    mocks.getState.mockImplementation(store.getState)
    const cleanup = attachEditorAutosaveController(store)
    try {
      const file = store.getState().openFiles[0]
      if (!file) {
        throw new Error('Missing test tab')
      }
      const restore = restoreMissingEditorFile(file)
      await Promise.resolve()
      await Promise.resolve()
      store.getState().setEditorDraft('/repo/file.ts', 'typed during failed restore')
      await vi.advanceTimersByTimeAsync(2500)
      gate.resolve()
      await restore
      await vi.advanceTimersByTimeAsync(2500)
      expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.has('/repo/file.ts')).toBe(false)
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('typed during failed restore')
      expect(store.getState().openFiles[0]?.externalMutation).toBe('deleted')
    } finally {
      cleanup()
    }
  })

  it.each([false, true])(
    'preserves drafts on a failed restore (newer mutation: %j)',
    async (newerMutation) => {
      const disk = stubEditorWindowWithDisk()
      const gate = Promise.withResolvers<void>()
      disk.fs.writeFile.mockImplementation(async () => {
        await gate.promise
        throw new Error('write refused')
      })
      const store = createEditorStore()
      openTestFile(store)
      store.getState().setEditorDraft('/repo/file.ts', 'retained draft')
      store.getState().markFileDirty('/repo/file.ts', true)
      store.getState().setExternalMutation('/repo/file.ts', 'deleted')
      mocks.getState.mockImplementation(store.getState)
      const cleanup = attachEditorAutosaveController(store)
      try {
        const file = store.getState().openFiles[0]
        if (!file) {
          throw new Error('Missing test tab')
        }
        const restore = restoreMissingEditorFile(file)
        await Promise.resolve()
        await Promise.resolve()
        expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
        if (newerMutation) {
          store.getState().setExternalMutation('/repo/file.ts', 'changed')
        }
        gate.resolve()
        await restore
        await vi.advanceTimersByTimeAsync(2500)
        expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
        expect(disk.files.has('/repo/file.ts')).toBe(false)
        expect(store.getState().editorDrafts['/repo/file.ts']).toBe('retained draft')
        expect(store.getState().openFiles[0]?.externalMutation).toBe(
          newerMutation ? 'changed' : 'deleted'
        )
        expect(store.getState().openFiles[0]?.isDirty).toBe(true)
      } finally {
        cleanup()
      }
    }
  )
})
