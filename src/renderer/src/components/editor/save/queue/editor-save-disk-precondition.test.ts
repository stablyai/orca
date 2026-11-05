import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEditorFileSave } from '../../autosave/editor-autosave'
import { attachEditorAutosaveController } from '../../autosave/editor-autosave-controller'
import {
  __clearSelfWriteRegistryForTests,
  hasRecentSelfWrite
} from '../../external-changes/editor-self-write-registry'
import { createEditorStore } from '../../autosave/editor-autosave-controller-test-fixture'
import { overwriteDiskWithTabEdits } from '../../external-changes/ExternalFileChangeBanner'
import {
  getDiskBaselineSignature,
  getWrittenContentDiskSignature
} from '../../../../../../shared/disk-baseline-signature'

import { GUARDED_PATH, openGuardedFile, stubGuardedDisk } from './editor-save-guarded-disk-fixture'

import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const mocks = vi.hoisted(() => ({
  getConnectionIdForFile: vi.fn(),
  readRuntimeFileContent: vi.fn()
}))
const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

const PATH = GUARDED_PATH

const openFile = openGuardedFile

describe('editor saves guarded by the disk precondition', () => {
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

  it('cleans a tab whose disk already holds the edit, without retaining a self-write stamp', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'user edit' })
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft: 'user edit' })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: PATH })

      await expect(disk.writeFile.mock.results[0]?.value).resolves.toEqual({
        ok: true,
        unchanged: true
      })
      expect(store.getState().openFiles[0]).toMatchObject({
        isDirty: false,
        lastKnownDiskSignature: getWrittenContentDiskSignature('user edit')
      })
      expect(store.getState().editorDrafts[PATH]).toBeUndefined()
      expect(hasRecentSelfWrite(PATH)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('blocks an autosave over an unnoticed agent write and raises the banner', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'original' })
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft: 'user edit' })
    // Simulate an external write without a watcher notification.
    disk.files.set(PATH, 'agent rewrite')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'user edit',
          diskPrecondition: {
            expectedSignature: getDiskBaselineSignature('original'),
            allowMissing: false,
            requireLosslessUtf8: true
          }
        })
      )
      expect(disk.files.get(PATH)).toBe('agent rewrite')
      const file = store.getState().openFiles[0]
      expect(file?.externalMutation).toBe('changed')
      expect(file?.isDirty).toBe(true)
      expect(store.getState().editorDrafts[PATH]).toBe('user edit')

      // The banner pauses autosave, so no retry loop follows.
      store.getState().setEditorDraft(PATH, 'user edit 2')
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.writeFile).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  it('keeps refusing explicit saves while the banner shows; only its Overwrite writes', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'agent rewrite' })
    const store = createEditorStore()
    storeRef.current = store
    openFile(store, { baseline: 'original', draft: 'user edit' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: PATH })).rejects.toThrow(/changed on disk/)
      expect(disk.files.get(PATH)).toBe('agent rewrite')
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')

      // Cmd+S again (from the editor or a preview) is not consent.
      await expect(requestEditorFileSave({ fileId: PATH })).rejects.toThrow(/changed on disk/)
      expect(disk.files.get(PATH)).toBe('agent rewrite')

      expect(await overwriteDiskWithTabEdits(store.getState().openFiles[0])).toBe(true)
      expect(disk.writeFile).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ diskPrecondition: expect.anything() })
      )
      expect(disk.files.get(PATH)).toBe('user edit')
      const file = store.getState().openFiles[0]
      expect(file?.externalMutation).toBeUndefined()
      expect(file?.isDirty).toBe(false)
      expect(file?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('user edit'))
    } finally {
      cleanup()
    }
  })

  // Why: a granted host path must never become a write of this computer's same path.
  it('refuses to save a host-granted tab whose owner resolves to this computer', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'original' })
    const store = createEditorStore()
    storeRef.current = store
    openFile(store, { baseline: 'original', draft: 'user edit' })
    store.getState().openFile({
      filePath: PATH,
      relativePath: PATH,
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit',
      terminalArtifactGrantId: 'g-1'
    })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: PATH })).rejects.toThrow(/no longer this tab/)
      expect(disk.writeFile).not.toHaveBeenCalled()
      expect(disk.files.get(PATH)).toBe('original')
    } finally {
      cleanup()
    }
  })

  it('refuses a save with no known disk version instead of writing unchecked', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'someone else' })
    const store = createEditorStore()
    storeRef.current = store
    openFile(store, { draft: 'mine' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: PATH })).rejects.toThrow(/changed on disk/)
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.writeFile).not.toHaveBeenCalled()
      expect(disk.files.get(PATH)).toBe('someone else')
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')

      expect(await overwriteDiskWithTabEdits(store.getState().openFiles[0])).toBe(true)
      expect(disk.files.get(PATH)).toBe('mine')
    } finally {
      cleanup()
    }
  })

  it('raises the banner when a save of a clean tab is refused', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'agent rewrite' })
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft: 'unused' })
    store.getState().clearEditorDraft(PATH)
    store.getState().markFileDirty(PATH, false)

    const cleanup = attachEditorAutosaveController(store)
    try {
      // Clean-tab fallback saves, such as Markdown whitespace normalization, still require a matching baseline.
      await expect(
        requestEditorFileSave({ fileId: PATH, fallbackContent: 'original' })
      ).rejects.toThrow(/changed on disk/)
      expect(disk.files.get(PATH)).toBe('agent rewrite')
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })

  it('does not let autosave recreate a file deleted behind the editor', async () => {
    const disk = stubGuardedDisk({})
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft: 'user edit' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.files.has(PATH)).toBe(false)
      expect(store.getState().openFiles[0]?.externalMutation).toBe('deleted')

      await requestEditorFileSave({ fileId: PATH })
      expect(disk.files.get(PATH)).toBe('user edit')
    } finally {
      cleanup()
    }
  })

  it('moves the one model baseline for a sibling typing during the save, so it saves next', async () => {
    let release = (): void => undefined
    let released = false
    const held = new Promise<void>((resolve) => {
      release = () => {
        released = true
        resolve()
      }
    })
    const disk = stubGuardedDisk({ [PATH]: 'A' }, () => (released ? Promise.resolve() : held))
    const store = createEditorStore()
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
          makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
        ]
      }
    })
    for (const worktreeId of ['wt-1', 'wt-2']) {
      store.getState().openFile({
        filePath: PATH,
        relativePath: 'file.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      })
    }
    const [saver, typer] = store.getState().openFiles
    for (const tab of [saver, typer]) {
      store.getState().setLastKnownDiskSignature(tab.id, getDiskBaselineSignature('A'))
    }
    store.getState().setEditorDraft(saver.id, 'X')
    store.getState().markFileDirty(saver.id, true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      const save = requestEditorFileSave({ fileId: saver.id })
      for (let tick = 0; tick < 20 && disk.writeFile.mock.calls.length === 0; tick += 1) {
        await vi.advanceTimersByTimeAsync(0)
      }
      store.getState().setEditorDraft(typer.id, 'X and more')
      store.getState().markFileDirty(typer.id, true)
      release()
      await save

      await requestEditorFileSave({ fileId: typer.id })
      expect(disk.files.get(PATH)).toBe('X and more')
      expect(store.getState().openFiles.every((tab) => tab.externalMutation === undefined)).toBe(
        true
      )
    } finally {
      cleanup()
    }
  })
})
