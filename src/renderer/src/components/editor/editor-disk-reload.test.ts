// Reload from Disk discards unsaved text only after a successful read nothing else superseded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  ORCA_EDITOR_FILE_CACHE_STALE_EVENT,
  ORCA_EDITOR_FILE_RELOADED_EVENT,
  requestEditorFileSave
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { GUARDED_PATH, openGuardedFile, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { reloadEditorFileFromDisk } from './editor-disk-reload'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => undefined,
  isWorktreeConnectionResolved: () => true
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' }),
  requireRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

function deferredRead(): { resolve: (content: string) => void; reject: (error: Error) => void } {
  let resolve: (content: string) => void = () => {}
  let reject: (error: Error) => void = () => {}
  mocks.readRuntimeFileContent.mockReturnValueOnce(
    new Promise((resolveRead, rejectRead) => {
      resolve = (content) => resolveRead({ content, isBinary: false })
      reject = rejectRead
    })
  )
  return { resolve: (content) => resolve(content), reject: (error) => reject(error) }
}

function setup() {
  const disk = stubGuardedDisk({ [GUARDED_PATH]: 'disk' })
  const store = createEditorStore()
  storeRef.current = store
  const id = openGuardedFile(store, { baseline: 'base', draft: 'mine' })
  const tab = () => store.getState().openFiles.find((file) => file.id === id)
  const installed: string[] = []
  window.addEventListener(ORCA_EDITOR_FILE_RELOADED_EVENT, (event) => {
    if (event instanceof CustomEvent) {
      installed.push(event.detail.content)
    }
  })
  return { disk, store, id, tab, installed }
}

describe('reloadEditorFileFromDisk', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(toast).mockClear()
    vi.mocked(toast.error).mockClear()
    mocks.readRuntimeFileContent.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('keeps the draft, dirty flag and conflict when the read fails', async () => {
    const { store, id, tab, installed } = setup()
    store.getState().setExternalMutation(id, 'changed')
    mocks.readRuntimeFileContent.mockRejectedValueOnce(new Error('SSH connection lost'))

    await reloadEditorFileFromDisk(id)

    expect(store.getState().editorDrafts[id]).toBe('mine')
    expect(tab()?.isDirty).toBe(true)
    expect(tab()?.externalMutation).toBe('changed')
    expect(installed).toEqual([])
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('installs the read bytes and baseline, and Undo raises no conflict disk never had', async () => {
    const { store, id, tab, installed } = setup()
    mocks.readRuntimeFileContent.mockResolvedValueOnce({ content: 'base', isBinary: false })

    await reloadEditorFileFromDisk(id)

    expect(installed).toEqual(['base'])
    expect(store.getState().editorDrafts[id]).toBeUndefined()
    expect(tab()?.isDirty).toBe(false)
    expect(tab()?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('base'))
    const undo: unknown = vi.mocked(toast).mock.calls[0]?.[1]?.action
    if (
      typeof undo === 'object' &&
      undo &&
      'onClick' in undo &&
      typeof undo.onClick === 'function'
    ) {
      undo.onClick()
    }
    expect(store.getState().editorDrafts[id]).toBe('mine')
    expect(tab()?.externalMutation ?? null).toBeNull()
  })

  it.each([
    [
      'typing',
      (store: ReturnType<typeof setup>['store'], id: string) =>
        store.getState().setEditorDraft(id, 'newer')
    ],
    [
      'an explicit save',
      async (_store: ReturnType<typeof setup>['store'], id: string) => {
        await requestEditorFileSave({ fileId: id })
      }
    ]
  ])('cancels when %s lands during the read', async (_name, act) => {
    const { disk, store, id, installed } = setup()
    disk.files.set(GUARDED_PATH, 'base')
    const cleanup = attachEditorAutosaveController(store)
    try {
      const read = deferredRead()
      const reload = reloadEditorFileFromDisk(id)
      await vi.advanceTimersByTimeAsync(0)
      await act(store, id)
      read.resolve('base')
      await reload

      expect(installed).toEqual([])
      expect(toast).toHaveBeenCalledOnce()
    } finally {
      cleanup()
    }
  })

  it('holds autosave so the draft being discarded never reaches disk', async () => {
    const { disk, store, id, installed } = setup()
    disk.files.set(GUARDED_PATH, 'base')
    const cleanup = attachEditorAutosaveController(store)
    try {
      const read = deferredRead()
      const reload = reloadEditorFileFromDisk(id)
      await vi.advanceTimersByTimeAsync(5000)
      expect(disk.writeFile).not.toHaveBeenCalled()
      read.resolve('base')
      await reload
      await vi.advanceTimersByTimeAsync(5000)

      expect(installed).toEqual(['base'])
      expect(disk.writeFile).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it("drops a clean tab's caches for a reread instead of probing disk", async () => {
    const { store, id } = setup()
    store.getState().clearEditorDraft(id)
    store.getState().markFileDirty(id, false)
    const stale: unknown[] = []
    window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, (event) => {
      if (event instanceof CustomEvent) {
        stale.push(event.detail)
      }
    })

    await reloadEditorFileFromDisk(id)

    expect(stale).toEqual([{ fileId: id, userReload: true }])
    expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
  })
})
