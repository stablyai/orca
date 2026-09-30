import type { StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { ORCA_EDITOR_SAVE_AND_CLOSE_EVENT } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  createFakeEditorDisk,
  createUntitledNoteStore,
  stubEditorWindowWithDisk,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'
import { discardEditorFileChangesAndClose } from './discard-editor-file-changes'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { getDiskBaselineSignature } from './diff-content-signature'

const storeHolder = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))

function requireStore(): StoreApi<AppState> {
  if (!storeHolder.store) {
    throw new Error('test store not initialised')
  }
  return storeHolder.store
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => requireStore().getState() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: vi.fn() }))

const FILE_ID = '/repo/untitled.md'

function typeInto(store: StoreApi<AppState>, content: string): void {
  store.getState().setEditorDraft(FILE_ID, content)
  store.getState().markFileDirty(FILE_ID, true)
}

/** What the editor panel records after a clean (re)load of the tab shows `content` from disk. */
function loadFromDisk(store: StoreApi<AppState>, content: string): void {
  store.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature(content))
}

function isReopenable(store: StoreApi<AppState>): boolean {
  return (store.getState().recentlyClosedEditorTabsByWorktree['wt-1'] ?? []).some(
    (tab) => tab.filePath === FILE_ID
  )
}

describe('untitled note save lifecycle', () => {
  let disk: FakeEditorDisk
  let store: StoreApi<AppState>

  beforeEach(() => {
    // Why: the window stub binds setTimeout, so fake timers must be installed first for autosave to be drivable.
    vi.useFakeTimers()
    disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_ID]: '' }))
    store = createUntitledNoteStore('untitled.md')
    storeHolder.store = store
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
    storeHolder.store = null
  })

  it.each([
    ['before its empty content loads', (): void => {}],
    ['after its empty content loads', (): void => loadFromDisk(store, '')]
  ])('still deletes an untouched untitled note closed %s', async (_when, load) => {
    load()

    store.getState().closeFile(FILE_ID)

    await vi.waitFor(() => expect(disk.files.has(FILE_ID)).toBe(false))
    expect(isReopenable(store)).toBe(false)
  })

  it.each([
    [
      'Save in the unsaved-changes prompt',
      async (): Promise<void> => {
        window.dispatchEvent(
          new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: FILE_ID } })
        )
        await vi.waitFor(() => expect(store.getState().openFiles).toHaveLength(0))
      }
    ],
    [
      'autosave, then a plain close',
      async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(1500)
        store.getState().closeFile(FILE_ID)
      }
    ]
  ])('keeps the typed note after %s', async (_route, saveAndClose) => {
    loadFromDisk(store, '')
    const cleanup = attachEditorAutosaveController(store)
    try {
      typeInto(store, 'my note')

      await saveAndClose()
      // Why: drain any stat → delete chain the close scheduled before asserting the note survived.
      await vi.advanceTimersByTimeAsync(0)

      expect(store.getState().openFiles).toHaveLength(0)
      expect(disk.files.get(FILE_ID)).toBe('my note')
      expect(disk.fs.deletePath).not.toHaveBeenCalled()
      expect(isReopenable(store)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('deletes the note when its last save emptied it', async () => {
    const cleanup = attachEditorAutosaveController(store)
    try {
      typeInto(store, 'a')
      await vi.advanceTimersByTimeAsync(1500)
      typeInto(store, '')
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.files.get(FILE_ID)).toBe('')

      store.getState().closeFile(FILE_ID)

      await vi.waitFor(() => expect(disk.files.has(FILE_ID)).toBe(false))
    } finally {
      cleanup()
    }
  })

  it("keeps autosaved content when Don't Save interrupts the in-flight write", async () => {
    loadFromDisk(store, '')
    let finishWrite: () => void = () => {}
    disk.fs.writeFile.mockImplementationOnce(
      ({ filePath, content }: { filePath: string; content: string }) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            disk.files.set(filePath, content)
            resolve()
          }
        })
    )
    const cleanup = attachEditorAutosaveController(store)
    try {
      typeInto(store, 'my note')
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)

      const discarded = discardEditorFileChangesAndClose(FILE_ID)
      finishWrite()
      await discarded
      // Why: the superseded save left the tab looking like a placeholder, so only the size check keeps the note.
      await vi.advanceTimersByTimeAsync(0)

      expect(store.getState().openFiles).toHaveLength(0)
      expect(disk.files.get(FILE_ID)).toBe('my note')
      expect(disk.fs.deletePath).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it.each([
    ['while its tab showed the new text', true],
    ['while its tab was in the background', false]
  ])('keeps a note an agent wrote into %s', async (_when, reloaded) => {
    loadFromDisk(store, '')
    disk.files.set(FILE_ID, 'agent text')
    if (reloaded) {
      loadFromDisk(store, 'agent text')
    }

    store.getState().closeFile(FILE_ID)

    // Why: a macrotask drains the stat → delete chain before asserting nothing was removed.
    await vi.advanceTimersByTimeAsync(0)
    expect(disk.files.get(FILE_ID)).toBe('agent text')
    expect(disk.fs.deletePath).not.toHaveBeenCalled()
    // Why: a background tab never reloaded the write, so only the size check knew it was a real note.
    expect(isReopenable(store)).toBe(reloaded)
  })

  it("removes a never-saved note's placeholder on Don't Save", async () => {
    loadFromDisk(store, '')
    typeInto(store, 'typed but never saved')

    await discardEditorFileChangesAndClose(FILE_ID)

    expect(store.getState().openFiles).toHaveLength(0)
    await vi.waitFor(() => expect(disk.files.has(FILE_ID)).toBe(false))
  })
})
