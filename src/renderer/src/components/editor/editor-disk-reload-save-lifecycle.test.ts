import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import {
  ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorFileSave,
  type EditorRequestFileReloadDetail
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  createEditorStore,
  stubEditorWindowWithDisk
} from './editor-autosave-controller-test-fixture'
import { requestEditorTabDiskReload } from './editor-tab-disk-reload'
import {
  ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT,
  type EditorSaveDirtyFilesDetail
} from '../../../../shared/editor-save-events'
import { getDiskBaselineSignature } from './diff-content-signature'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => AppState>(),
  toast: Object.assign(vi.fn(), { error: vi.fn() })
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const FILE = '/repo/a.ts'
let store: ReturnType<typeof createEditorStore>
let disk: ReturnType<typeof stubEditorWindowWithDisk>
let dispose: () => void
let requests: EditorRequestFileReloadDetail[]
const reader = (event: Event): void => {
  if (event instanceof CustomEvent) {
    const detail: EditorRequestFileReloadDetail = event.detail
    detail.claim()
    requests.push(detail)
  }
}
function openDirty(name: string): void {
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
function requestAt(index = 0): EditorRequestFileReloadDetail {
  const request = requests[index]
  if (!request) {
    throw new Error('The editor panel did not receive its reload request')
  }
  return request
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  disk = stubEditorWindowWithDisk()
  disk.files.set(FILE, 'external disk update')
  store = createEditorStore()
  mocks.getState.mockImplementation(store.getState)
  openDirty('a')
  requests = []
  dispose = attachEditorAutosaveController(store)
  window.addEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, reader)
})
afterEach(() => {
  dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __clearSelfWriteRegistryForTests()
})

describe('manual reload with the real editor save controller', () => {
  it('does not save the discarded draft during or after a successful reload', async () => {
    await requestEditorTabDiskReload(FILE)
    openDirty('b')
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.files.get(FILE)).toBe('external disk update')
    expect(disk.files.get('/repo/b.ts')).toBe('draft b')
    expect(requestAt().beforeApply()).toBe(true)
    requestAt().onSettled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.files.get(FILE)).toBe('external disk update')
    expect(store.getState().editorDrafts[FILE]).toBeUndefined()
    expect(store.getState().openFiles.find((file) => file.id === FILE)?.isDirty).toBe(false)
    expect(mocks.toast).toHaveBeenCalledOnce()
  })

  it('retains a conflict and its draft after failure without resuming destructive autosave', async () => {
    store.getState().setExternalMutation(FILE, 'changed')
    await requestEditorTabDiskReload(FILE)
    requestAt().onError(new Error('SSH connection lost'))
    requestAt().onSettled()
    openDirty('b')
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.files.get(FILE)).toBe('external disk update')
    expect(store.getState().editorDrafts[FILE]).toBe('draft a')
    expect(store.getState().openFiles.find((file) => file.id === FILE)?.externalMutation).toBe(
      'changed'
    )
    expect(mocks.toast.error).toHaveBeenCalledOnce()
  })

  it('restores normal autosave after a read fails without a prior conflict', async () => {
    await requestEditorTabDiskReload(FILE)
    requestAt().onError(new Error('Temporary read failure'))
    requestAt().onSettled()
    store.getState().setEditorDraft(FILE, 'new edit after failure')
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.files.get(FILE)).toBe('new edit after failure')
  })

  it('lets an explicit save win over a pending reload', async () => {
    await requestEditorTabDiskReload(FILE)
    store.getState().setEditorDraft(FILE, 'explicitly saved newer edit')
    await requestEditorFileSave({ fileId: FILE })
    expect(requestAt().beforeApply()).toBe(false)
    requestAt().onSettled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.files.get(FILE)).toBe('explicitly saved newer edit')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('lets a same-baseline clean save win over a pending reload', async () => {
    store.getState().clearEditorDraft(FILE)
    store.getState().markFileDirty(FILE, false)
    store.getState().setLastKnownDiskSignature(FILE, getDiskBaselineSignature('baseline'))
    await requestEditorTabDiskReload(FILE)
    await requestEditorFileSave({ fileId: FILE, fallbackContent: 'baseline' })
    expect(disk.files.get(FILE)).toBe('baseline')
    expect(requestAt().beforeApply()).toBe(false)
    requestAt().onSettled()
  })

  it('keeps a draft after an explicit save fails during a pending reload', async () => {
    await requestEditorTabDiskReload(FILE)
    disk.fs.writeFile.mockRejectedValueOnce(new Error('connection dropped'))
    await expect(requestEditorFileSave({ fileId: FILE })).rejects.toThrow('connection dropped')
    expect(requestAt().beforeApply()).toBe(false)
    requestAt().onSettled()
    expect(store.getState().editorDrafts[FILE]).toBe('draft a')
  })

  it('cancels replacement while the explicit write is still in flight', async () => {
    let finishWrite = (): void => {}
    disk.fs.writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    await requestEditorTabDiskReload(FILE)
    const save = requestEditorFileSave({ fileId: FILE })
    await vi.advanceTimersByTimeAsync(0)
    expect(requestAt().beforeApply()).toBe(false)
    requestAt().onSettled()
    finishWrite()
    await save
  })

  it('does not cancel for a save to a different file', async () => {
    await requestEditorTabDiskReload(FILE)
    openDirty('b')
    await requestEditorFileSave({ fileId: '/repo/b.ts' })
    expect(requestAt().beforeApply()).toBe(true)
    requestAt().onSettled()
    expect(disk.files.get(FILE)).toBe('external disk update')
  })

  it('preserves the draft when save-and-close fails during the read', async () => {
    await requestEditorTabDiskReload(FILE)
    disk.fs.writeFile.mockRejectedValueOnce(new Error('connection dropped'))
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: FILE } })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(requestAt().beforeApply()).toBe(false)
    requestAt().onSettled()
    expect(store.getState().editorDrafts[FILE]).toBe('draft a')
  })

  it('preserves the draft when bulk save fails during the read', async () => {
    await requestEditorTabDiskReload(FILE)
    disk.fs.writeFile.mockRejectedValueOnce(new Error('connection dropped'))
    const save = new Promise<void>((resolve, reject) => {
      window.dispatchEvent(
        new CustomEvent<EditorSaveDirtyFilesDetail>(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
          detail: { claim: () => {}, resolve, reject: (message) => reject(new Error(message)) }
        })
      )
    })
    await expect(save).rejects.toThrow('connection dropped')
    expect(requestAt().beforeApply()).toBe(false)
    requestAt().onSettled()
    expect(store.getState().editorDrafts[FILE]).toBe('draft a')
  })

  it('does not strand autosave if no panel handles the reload', async () => {
    window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, reader)
    await requestEditorTabDiskReload(FILE)
    store.getState().setEditorDraft(FILE, 'new edit without a panel')
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.files.get(FILE)).toBe('new edit without a panel')
  })

  it('keeps autosave suspended until every panel reader settles', async () => {
    const synchronousFailedReader = (event: Event): void => {
      if (event instanceof CustomEvent) {
        const detail: EditorRequestFileReloadDetail = event.detail
        detail.claim()
        detail.onSettled()
      }
    }
    window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, reader)
    window.addEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, synchronousFailedReader)
    window.addEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, reader)
    await requestEditorTabDiskReload(FILE)
    openDirty('b')
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.files.get(FILE)).toBe('external disk update')
    expect(requestAt().beforeApply()).toBe(true)
    requestAt().onSettled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(disk.files.get(FILE)).toBe('external disk update')
  })
})
