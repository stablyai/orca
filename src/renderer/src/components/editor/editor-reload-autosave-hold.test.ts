import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEditorSaveQuiesce, requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  createEditorStore,
  stubEditorWindowWithDisk
} from './editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
function openDirty(store: ReturnType<typeof createEditorStore>, name: string): void {
  store.getState().openFile({
    filePath: `/repo/${name}.ts`,
    relativePath: `${name}.ts`,
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setEditorDraft(`/repo/${name}.ts`, `draft ${name}`)
  store.getState().markFileDirty(`/repo/${name}.ts`, true)
}
function hold() {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __clearSelfWriteRegistryForTests()
})

describe('autosave suspension during a manual disk reload', () => {
  it('does not overwrite disk when another tab changes while the read is pending', async () => {
    const disk = stubEditorWindowWithDisk()
    disk.files.set('/repo/a.ts', 'external disk update')
    const store = createEditorStore()
    openDirty(store, 'a')
    const cleanup = attachEditorAutosaveController(store)
    const reload = hold()
    try {
      await requestEditorSaveQuiesce({ fileId: '/repo/a.ts' }, reload.promise)
      openDirty(store, 'b')
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.files.get('/repo/a.ts')).toBe('external disk update')
      expect(disk.files.get('/repo/b.ts')).toBe('draft b')
      reload.release()
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.files.get('/repo/a.ts')).toBe('draft a')
    } finally {
      cleanup()
    }
  })

  it('keeps overlapping reloads suspended until both readers finish', async () => {
    const disk = stubEditorWindowWithDisk()
    const store = createEditorStore()
    openDirty(store, 'a')
    const cleanup = attachEditorAutosaveController(store)
    const first = hold()
    const second = hold()
    try {
      await requestEditorSaveQuiesce({ fileId: '/repo/a.ts' }, first.promise)
      await requestEditorSaveQuiesce({ fileId: '/repo/a.ts' }, second.promise)
      first.release()
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.fs.writeFile).not.toHaveBeenCalled()
      second.release()
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.files.get('/repo/a.ts')).toBe('draft a')
    } finally {
      cleanup()
    }
  })

  it('allows an explicit save as newer user intent', async () => {
    const disk = stubEditorWindowWithDisk()
    const store = createEditorStore()
    openDirty(store, 'a')
    const cleanup = attachEditorAutosaveController(store)
    const reload = hold()
    try {
      await requestEditorSaveQuiesce({ fileId: '/repo/a.ts' }, reload.promise)
      await requestEditorFileSave({ fileId: '/repo/a.ts' })
      expect(disk.files.get('/repo/a.ts')).toBe('draft a')
    } finally {
      reload.release()
      cleanup()
    }
  })

  it('does not restart autosave after the controller is disposed', async () => {
    const disk = stubEditorWindowWithDisk()
    const store = createEditorStore()
    openDirty(store, 'a')
    const cleanup = attachEditorAutosaveController(store)
    const reload = hold()
    await requestEditorSaveQuiesce({ fileId: '/repo/a.ts' }, reload.promise)
    cleanup()
    reload.release()
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.fs.writeFile).not.toHaveBeenCalled()
  })
})
