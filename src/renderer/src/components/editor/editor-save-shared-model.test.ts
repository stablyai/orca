// Why: every save-path scenario with two tabs (two workspaces) showing one Monaco model. Shared
// text, baseline and conflict state must stay in step across both tabs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_FILE_CACHE_STALE_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorFileSave,
  type EditorSaveAndCloseDetail
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import {
  keepTabEditsOverExternalChange,
  overwriteDiskWithTabEdits,
  reloadTabContentFromDisk
} from './ExternalFileChangeBanner'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../../../../shared/editor-save-events'
import { GUARDED_PATH, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

function openSharedTabs(disk: string) {
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
  const edit = (id: string, text: string): void => {
    store.getState().setEditorDraft(id, text)
    store.getState().markFileDirty(id, true)
  }
  const tab = (id: string) => store.getState().openFiles.find((file) => file.id === id)
  return { store, a, b, edit, tab }
}

/** The toast's Undo action, as the test calls it. */
type ClickAction = { onClick: () => void }

function isClickAction(value: unknown): value is ClickAction {
  return (
    typeof value === 'object' &&
    value !== null &&
    'onClick' in value &&
    typeof value.onClick === 'function'
  )
}

function sameBaseline(store: ReturnType<typeof createEditorStore>): boolean {
  return new Set(store.getState().openFiles.map((file) => file.lastKnownDiskSignature)).size === 1
}

describe('two tabs sharing one model', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it.each(['save', 'autosave'] as const)(
    '%s moves the clean sibling baseline and drops its cache, pushing no text',
    async (how) => {
      const disk = stubGuardedDisk({ [GUARDED_PATH]: 'A' })
      const { store, a, b, edit, tab } = openSharedTabs('A')
      const dropped: string[] = []
      window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, (event) => {
        if (event instanceof CustomEvent) {
          dropped.push(event.detail.fileId)
        }
      })
      edit(a.id, 'X')
      const cleanup = attachEditorAutosaveController(store)
      try {
        await (how === 'save'
          ? requestEditorFileSave({ fileId: a.id })
          : vi.advanceTimersByTimeAsync(1500))
        expect(disk.files.get(GUARDED_PATH)).toBe('X')
        expect(dropped).toEqual([b.id])
        expect(store.getState().editorDrafts[b.id]).toBeUndefined()
        expect(sameBaseline(store)).toBe(true)
        expect(tab(b.id)?.isDirty).toBe(false)
      } finally {
        cleanup()
      }
    }
  )

  it('Keep moves the sibling baseline only, never its text', async () => {
    stubGuardedDisk({ [GUARDED_PATH]: 'B' })
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    store.getState().setExternalMutation(a.id, 'changed')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'B', isBinary: false })

    keepTabEditsOverExternalChange(store.getState().openFiles[0])
    await vi.advanceTimersByTimeAsync(0)

    expect(store.getState().editorDrafts[b.id]).toBeUndefined()
    expect(tab(b.id)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('B'))
    expect(sameBaseline(store)).toBe(true)
  })

  it('Reload discards both drafts and reloads both tabs', () => {
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    edit(b.id, 'mine')
    for (const id of [a.id, b.id]) {
      store.getState().setExternalMutation(id, 'changed')
    }
    const reloadContent = vi.fn()

    reloadTabContentFromDisk(store.getState().openFiles[0], reloadContent)

    expect(reloadContent.mock.calls.map(([file]) => file.id).sort()).toEqual([a.id, b.id].sort())
    for (const id of [a.id, b.id]) {
      expect(store.getState().editorDrafts[id]).toBeUndefined()
      expect(tab(id)?.externalMutation).toBeUndefined()
    }
  })

  it('Overwrite settles the conflict on both tabs', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'agent' })
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    for (const id of [a.id, b.id]) {
      store.getState().setExternalMutation(id, 'changed')
    }
    const cleanup = attachEditorAutosaveController(store)
    try {
      expect(await overwriteDiskWithTabEdits(store.getState().openFiles[0])).toBe(true)
      expect(disk.files.get(GUARDED_PATH)).toBe('mine')
      expect(tab(b.id)?.externalMutation).toBeUndefined()
      expect(sameBaseline(store)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("an external change in one workspace marks the sibling's shared text too", () => {
    stubGuardedDisk({ [GUARDED_PATH]: 'A' })
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    edit(b.id, 'mine')
    const cleanup = attachEditorAutosaveController(store)
    try {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
          detail: { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'file.ts' }
        })
      )
      expect(tab(a.id)?.externalMutation).toBe('changed')
      expect(tab(b.id)?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })

  it('a refused save-and-close raises the conflict on both tabs and closes neither', async () => {
    stubGuardedDisk({ [GUARDED_PATH]: 'agent' })
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    const cleanup = attachEditorAutosaveController(store)
    try {
      const reason = await new Promise((resolve) => {
        const detail: EditorSaveAndCloseDetail = { fileId: a.id, onNotClosed: resolve }
        window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail }))
      })
      expect(reason).toBe('blocked-stale')
      expect(store.getState().openFiles).toHaveLength(2)
      expect(tab(b.id)?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })

  it('the quit save writes the dirty tab and moves the clean sibling with it', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'A' })
    const { store, a, b, edit } = openSharedTabs('A')
    edit(a.id, 'quit text')
    const cleanup = attachEditorAutosaveController(store)
    try {
      await new Promise<void>((resolve, reject) => {
        window.dispatchEvent(
          new CustomEvent(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
            detail: { claim: () => undefined, resolve, reject: (m: string) => reject(new Error(m)) }
          })
        )
      })
      expect(disk.files.get(GUARDED_PATH)).toBe('quit text')
      expect(store.getState().openFiles.find((f) => f.id === b.id)?.isDirty).toBe(false)
      expect(sameBaseline(store)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("never touches a rich-markdown sibling's pending typing; at worst its save is refused", async () => {
    const md = '/repo/notes.md'
    let released = false
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = () => {
        released = true
        resolve()
      }
    })
    const disk = stubGuardedDisk({ [md]: 'A' }, () => (released ? Promise.resolve() : held))
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
        filePath: md,
        relativePath: 'notes.md',
        worktreeId,
        language: 'markdown',
        mode: 'edit'
      })
    }
    const [code, rich] = store.getState().openFiles
    // The first tab shows Monaco source; the second keeps the default rich view.
    store.getState().setMarkdownViewMode(code.id, 'source')
    for (const tab of [code, rich]) {
      store.getState().setLastKnownDiskSignature(tab.id, getDiskBaselineSignature('A'))
    }
    store.getState().setEditorDraft(code.id, 'source edit')
    store.getState().markFileDirty(code.id, true)
    store.getState().setEditorDraft(rich.id, 'rich typing')
    store.getState().markFileDirty(rich.id, true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      const slowSave = requestEditorFileSave({ fileId: code.id })
      for (let tick = 0; tick < 20 && disk.writeFile.mock.calls.length === 0; tick += 1) {
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(disk.writeFile).toHaveBeenCalledTimes(1)
      store.getState().setEditorDraft(rich.id, 'rich typing, more')
      release()
      await slowSave
      expect(disk.files.get(md)).toBe('source edit')
      expect(store.getState().editorDrafts[rich.id]).toBe('rich typing, more')
      expect(
        store.getState().openFiles.find((tab) => tab.id === rich.id)?.lastKnownDiskSignature
      ).toBe(getDiskBaselineSignature('A'))

      await expect(requestEditorFileSave({ fileId: rich.id })).rejects.toThrow(/changed on disk/)
      expect(store.getState().editorDrafts[rich.id]).toBe('rich typing, more')
      expect(disk.files.get(md)).toBe('source edit')
    } finally {
      cleanup()
    }
  })

  it("Reload from a clean tab offers Undo of the sibling's discarded edits", () => {
    const { store, a, b, edit } = openSharedTabs('A')
    edit(b.id, 'mine')
    for (const id of [a.id, b.id]) {
      store.getState().setExternalMutation(id, 'changed')
    }
    const toastMock = vi.mocked(toast)
    toastMock.mockClear()
    reloadTabContentFromDisk(store.getState().openFiles[0], vi.fn())
    expect(store.getState().editorDrafts[b.id]).toBeUndefined()

    const undo: unknown = toastMock.mock.calls[0]?.[1]?.action
    expect(isClickAction(undo)).toBe(true)
    if (isClickAction(undo)) {
      undo.onClick()
    }

    expect(store.getState().editorDrafts[b.id]).toBe('mine')
  })

  it('Keep clears the conflict on every tab of the model before the disk read settles', () => {
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    for (const id of [a.id, b.id]) {
      store.getState().setExternalMutation(id, 'changed')
    }
    mocks.readRuntimeFileContent.mockReturnValue(new Promise(() => {}))

    keepTabEditsOverExternalChange(store.getState().openFiles[0])

    expect(tab(b.id)?.externalMutation).toBeUndefined()
  })

  it('Undo of Reload yields to a sibling that typed since, touching neither tab', () => {
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    edit(b.id, 'mine')
    const toastMock = vi.mocked(toast)
    toastMock.mockClear()
    reloadTabContentFromDisk(store.getState().openFiles[0], vi.fn())
    edit(b.id, 'typed after reload')

    const undo: unknown = toastMock.mock.calls[0]?.[1]?.action
    expect(isClickAction(undo)).toBe(true)
    if (isClickAction(undo)) {
      undo.onClick()
    }

    expect(store.getState().editorDrafts[a.id]).toBeUndefined()
    expect(store.getState().editorDrafts[b.id]).toBe('typed after reload')
    expect(tab(b.id)?.externalMutation).toBeUndefined()
  })

  it('Undo of Reload yields to typing in a workspace tab that joined the model after the reload', () => {
    const { store, a, b, edit } = openSharedTabs('A')
    store.getState().setEditorViewMode(b.id, 'changes')
    edit(a.id, 'mine')
    const toastMock = vi.mocked(toast)
    toastMock.mockClear()
    reloadTabContentFromDisk(store.getState().openFiles[0], vi.fn())
    // The other workspace's tab switches to the code view, joining the model, and types.
    store.getState().setEditorViewMode(b.id, 'edit')
    edit(b.id, 'typed in the joined tab')

    const undo: unknown = toastMock.mock.calls[0]?.[1]?.action
    expect(isClickAction(undo)).toBe(true)
    if (isClickAction(undo)) {
      undo.onClick()
    }

    expect(store.getState().editorDrafts[a.id]).toBeUndefined()
    expect(store.getState().editorDrafts[b.id]).toBe('typed in the joined tab')
  })

  it('Undo of Reload leaves alone a reloaded tab that left the model and typed', () => {
    const { store, a, b, edit, tab } = openSharedTabs('A')
    edit(a.id, 'mine')
    const toastMock = vi.mocked(toast)
    toastMock.mockClear()
    reloadTabContentFromDisk(store.getState().openFiles[0], vi.fn())
    // The other workspace's tab switches to the Changes view, leaving the model, and types.
    store.getState().setEditorViewMode(b.id, 'changes')
    edit(b.id, 'typed in the Changes view')

    const undo: unknown = toastMock.mock.calls[0]?.[1]?.action
    expect(isClickAction(undo)).toBe(true)
    if (isClickAction(undo)) {
      undo.onClick()
    }

    expect(store.getState().editorDrafts[a.id]).toBe('mine')
    expect(store.getState().editorDrafts[b.id]).toBe('typed in the Changes view')
    expect(tab(b.id)?.externalMutation).toBeUndefined()
  })

  it('never reaches a Changes-view tab through Keep or Reload', async () => {
    stubGuardedDisk({ [GUARDED_PATH]: 'B' })
    const { store, a, b, edit, tab } = openSharedTabs('A')
    store.getState().setEditorViewMode(b.id, 'changes')
    edit(a.id, 'mine')
    edit(b.id, 'changes edit')
    store.getState().setExternalMutation(a.id, 'changed')
    store.getState().setExternalMutation(b.id, 'changed')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'B', isBinary: false })

    keepTabEditsOverExternalChange(store.getState().openFiles[0])
    await vi.advanceTimersByTimeAsync(0)
    expect(tab(b.id)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('A'))
    expect(tab(b.id)?.externalMutation).toBe('changed')

    const reloadContent = vi.fn()
    reloadTabContentFromDisk(store.getState().openFiles[0], reloadContent)
    expect(reloadContent.mock.calls.map(([file]) => file.id)).toEqual([a.id])
    expect(store.getState().editorDrafts[b.id]).toBe('changes edit')
  })
})
