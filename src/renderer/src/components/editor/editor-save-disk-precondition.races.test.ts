import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_EDITOR_FILE_CACHE_STALE_EVENT,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorFileSave,
  requestEditorSaveQuiesce,
  type EditorSaveAndCloseDetail
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { keepTabEditsOverExternalChange } from './ExternalFileChangeBanner'
import { attemptEditorFileSave } from './editor-file-save-attempt'
import {
  getDiskBaselineSignature,
  getWrittenContentDiskSignature
} from '../../../../shared/disk-baseline-signature'
import { GUARDED_PATH, openGuardedFile, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn(), toastError: vi.fn() }))
const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: mocks.toastError }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('guarded editor saves under races', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
    mocks.toastError.mockReset()
  })

  it('guards an unstaged diff tab, which writes the working-tree file', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'agent rewrite' })
    const store = createEditorStore()
    store.getState().openDiff('wt-1', GUARDED_PATH, 'file.ts', 'typescript', false)
    const diff = store.getState().openFiles[0]
    expect(diff?.diffSource).toBe('unstaged')
    store.getState().setLastKnownDiskSignature(diff.id, getDiskBaselineSignature('original'))
    store.getState().setEditorDraft(diff.id, 'diff edit')
    store.getState().markFileDirty(diff.id, true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.get(GUARDED_PATH)).toBe('agent rewrite')
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })

  it('rebaselines to its own write even when a quiesce supersedes the save mid-write', async () => {
    const gate = deferred()
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'original' }, () => gate.promise)
    const store = createEditorStore()
    openGuardedFile(store, { baseline: 'original', draft: 'first' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      const save = requestEditorFileSave({ fileId: GUARDED_PATH })
      await vi.advanceTimersByTimeAsync(0)
      const quiesce = requestEditorSaveQuiesce({ fileId: GUARDED_PATH })
      gate.resolve()
      await save
      await quiesce
      expect(store.getState().openFiles[0]?.lastKnownDiskSignature).toBe(
        getWrittenContentDiskSignature('first')
      )

      store.getState().setEditorDraft(GUARDED_PATH, 'second')
      await requestEditorFileSave({ fileId: GUARDED_PATH })
      expect(disk.files.get(GUARDED_PATH)).toBe('second')
    } finally {
      cleanup()
    }
  })

  it("does not let Keep's older disk read restamp over a write that finished after it", async () => {
    const gate = deferred()
    stubGuardedDisk({ [GUARDED_PATH]: 'agent rewrite' }, () => gate.promise)
    const store = createEditorStore()
    storeRef.current = store
    openGuardedFile(store, { baseline: 'original', draft: 'mine' })
    store.getState().setExternalMutation(GUARDED_PATH, 'changed')
    const read = deferred<{ content: string; isBinary: boolean }>()
    mocks.readRuntimeFileContent.mockReturnValue(read.promise)

    const cleanup = attachEditorAutosaveController(store)
    try {
      // An Overwrite is already writing when the user clicks Keep.
      const save = requestEditorFileSave({ fileId: GUARDED_PATH, overwrite: true })
      await vi.advanceTimersByTimeAsync(0)
      keepTabEditsOverExternalChange(store.getState().openFiles[0])
      gate.resolve()
      await save
      read.resolve({ content: 'agent rewrite', isBinary: false })
      await vi.advanceTimersByTimeAsync(0)

      expect(store.getState().openFiles[0]?.lastKnownDiskSignature).toBe(
        getWrittenContentDiskSignature('mine')
      )
    } finally {
      cleanup()
    }
  })

  it("drops a clean sibling's stale cache on a write, so a remount loads the written text", async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'A' })
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
        filePath: GUARDED_PATH,
        relativePath: 'file.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      })
    }
    const [saver, sibling] = store.getState().openFiles
    for (const tab of [saver, sibling]) {
      store.getState().setLastKnownDiskSignature(tab.id, getDiskBaselineSignature('A'))
    }
    // The panel's per-tab text cache, kept the way the panel keeps it.
    const cache = new Map([
      [saver.id, 'A'],
      [sibling.id, 'A']
    ])
    const track = (event: Event): void => {
      if (event instanceof CustomEvent) {
        cache.set(event.detail.fileId, event.detail.content)
      }
    }
    // A dropped cache reloads from disk on the next mount; no text is pushed between tabs.
    const drop = (event: Event): void => {
      if (event instanceof CustomEvent) {
        cache.delete(event.detail.fileId)
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, track)
    window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, drop)
    store.getState().setEditorDraft(saver.id, 'B')
    store.getState().markFileDirty(saver.id, true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: saver.id })
      expect(cache.has(sibling.id)).toBe(false)

      // Remount the sibling (its cache reloads from disk), edit, and save.
      const reloaded = cache.get(sibling.id) ?? disk.files.get(GUARDED_PATH)
      expect(reloaded).toBe('B')
      store.getState().setEditorDraft(sibling.id, `${reloaded} edited`)
      store.getState().markFileDirty(sibling.id, true)
      await requestEditorFileSave({ fileId: sibling.id })
      expect(disk.files.get(GUARDED_PATH)).toBe('B edited')
    } finally {
      cleanup()
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, track)
      window.removeEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, drop)
    }
  })

  function openSharedModelTabs(disk: string) {
    const store = createEditorStore()
    storeRef.current = store
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
        filePath: GUARDED_PATH,
        relativePath: 'file.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      })
    }
    const [a, b] = store.getState().openFiles
    for (const tab of [a, b]) {
      store.getState().setLastKnownDiskSignature(tab.id, getDiskBaselineSignature(disk))
    }
    return { store, a, b }
  }

  it('finishes queued identical sibling saves the same way, ending on the saved text', async () => {
    const gate = deferred()
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'A' }, () => gate.promise)
    const { store, a, b } = openSharedModelTabs('A')
    for (const tab of [a, b]) {
      store.getState().setEditorDraft(tab.id, 'X')
      store.getState().markFileDirty(tab.id, true)
    }
    // A mounted consumer: the panel's per-tab text, fed by saved events, is what a model mounts.
    const shown = new Map([
      [a.id, 'A'],
      [b.id, 'A']
    ])
    const onSaved = (event: Event): void => {
      if (event instanceof CustomEvent) {
        shown.set(event.detail.fileId, event.detail.content)
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)

    const cleanup = attachEditorAutosaveController(store)
    try {
      const saves = Promise.all([
        requestEditorFileSave({ fileId: a.id }),
        requestEditorFileSave({ fileId: b.id })
      ])
      gate.resolve()
      await saves

      // The second guarded save completes without rewriting the identical bytes.
      expect(disk.writeFile).toHaveBeenCalledTimes(2)
      expect(disk.files.get(GUARDED_PATH)).toBe('X')
      expect([...shown.values()]).toEqual(['X', 'X'])
      for (const tab of store.getState().openFiles) {
        expect(tab.isDirty).toBe(false)
        expect(tab.externalMutation).toBeUndefined()
        expect(store.getState().editorDrafts[tab.id]).toBeUndefined()
      }
    } finally {
      cleanup()
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
    }
  })

  it('makes Cmd+S in one tab wait for Keep My Edits in its sibling', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'B' })
    const { store, a, b } = openSharedModelTabs('A')
    for (const tab of [a, b]) {
      store.getState().setEditorDraft(tab.id, 'mine')
      store.getState().markFileDirty(tab.id, true)
    }
    store.getState().setExternalMutation(a.id, 'changed')
    const read = deferred<{ content: string; isBinary: boolean }>()
    mocks.readRuntimeFileContent.mockReturnValue(read.promise)

    const cleanup = attachEditorAutosaveController(store)
    try {
      keepTabEditsOverExternalChange(store.getState().openFiles[0])
      const save = requestEditorFileSave({ fileId: b.id })
      read.resolve({ content: 'B', isBinary: false })
      await save
      expect(disk.files.get(GUARDED_PATH)).toBe('mine')
    } finally {
      cleanup()
    }
  })

  it('after Keep, pushes no text to a clean sibling, keeps its cache, and saves the kept edits', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'agent rewrite' })
    const { store, a, b } = openSharedModelTabs('A')
    store.getState().setEditorDraft(a.id, 'kept edits')
    store.getState().markFileDirty(a.id, true)
    store.getState().setExternalMutation(a.id, 'changed')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'agent rewrite', isBinary: false })
    const dropped: string[] = []
    const onStale = (event: Event): void => {
      if (event instanceof CustomEvent) {
        dropped.push(event.detail.fileId)
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)

    const cleanup = attachEditorAutosaveController(store)
    try {
      keepTabEditsOverExternalChange(store.getState().openFiles[0])
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getState().editorDrafts[b.id]).toBeUndefined()
      // The model holds the unsaved kept edits, so the sibling's cache is not dropped for disk.
      expect(dropped).toEqual([])

      await requestEditorFileSave({ fileId: a.id })
      expect(disk.files.get(GUARDED_PATH)).toBe('kept edits')
    } finally {
      cleanup()
      window.removeEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
    }
  })

  it('reports a refused explicit save with the stale-file message', async () => {
    stubGuardedDisk({ [GUARDED_PATH]: 'agent rewrite' })
    const store = createEditorStore()
    openGuardedFile(store, { baseline: 'original', draft: 'mine' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      expect(await attemptEditorFileSave({ fileId: GUARDED_PATH })).toBe(false)
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/changed on disk/))
    } finally {
      cleanup()
    }
  })

  it('answers a refused save-and-close at once and keeps the tab open', async () => {
    stubGuardedDisk({ [GUARDED_PATH]: 'agent rewrite' })
    const store = createEditorStore()
    openGuardedFile(store, { baseline: 'original', draft: 'mine' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      const reason = await new Promise((resolve) => {
        const detail: EditorSaveAndCloseDetail = { fileId: GUARDED_PATH, onNotClosed: resolve }
        window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail }))
      })
      expect(reason).toBe('blocked-stale')
      expect(store.getState().openFiles).toHaveLength(1)
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })
})
