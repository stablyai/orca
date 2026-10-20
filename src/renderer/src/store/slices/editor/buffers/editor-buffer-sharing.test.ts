import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  createEditorStore,
  stubEditorWindowWithDisk,
  type FakeEditorDisk
} from '@/components/editor/editor-autosave-controller-test-fixture'
import { createEditorSaveQueue } from '@/components/editor/editor-save-queue'
import { __clearSelfWriteRegistryForTests } from '@/components/editor/editor-self-write-registry'
import {
  nextEditorEditSequence,
  registerPendingEditorFlush
} from '@/components/editor/editor-pending-flush'
import { flushEditorBufferViews } from '@/components/editor/editor-buffer-flush'
import { assertEditorBufferInvariant } from '@/store/editor-buffer-record-lifecycle'
import { buildEditorSessionData } from '@/lib/workspace-session'
import {
  editorBufferIdOf,
  editorBufferViewIds,
  liveEditorBufferViewOf,
  rekeyEditorBuffers
} from './editor-buffer-record'
import { attachEditorAutosaveController } from '@/components/editor/editor-autosave-controller'
import {
  notifyEditorExternalFileChange,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { beginEditorBufferFileRead } from './editor-buffer-read-freshness'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'
import { editorModelOwnerKeyOf } from './editor-buffer-identity'
import { hasOtherSavingEditorView, needsSavePromptOnClose } from './editor-buffer-close-rule'
import { getReplaceablePreviewFileId } from '../tabs/workspace-editor-item'

const fixture = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => fixture.store?.getState() }
}))

const FILE = '/repo/a.ts'

function openTab(
  store: StoreApi<AppState>,
  worktreeId: string,
  extra: Partial<OpenFile> = {},
  options?: { preview?: boolean }
): string {
  store.getState().openFile(
    {
      filePath: FILE,
      relativePath: 'a.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit',
      ...extra
    },
    options
  )
  return store.getState().openFiles.at(-1)?.id ?? ''
}

function type(store: StoreApi<AppState>, id: string, text: string): void {
  store.getState().setEditorDraft(id, text)
  store.getState().markFileDirty(id, true)
}

function tab(store: StoreApi<AppState>, id: string): OpenFile | undefined {
  return store.getState().openFiles.find((file) => file.id === id)
}

function modelOwnerOf(store: StoreApi<AppState>, id: string): string {
  return editorModelOwnerKeyOf(store.getState(), tab(store, id)!)
}

describe('one editor buffer record per physical file', () => {
  let store: StoreApi<AppState>
  let disk: FakeEditorDisk

  beforeEach(() => {
    disk = stubEditorWindowWithDisk()
    store = createEditorStore()
    fixture.store = store
    store.setState({
      browserTabsByWorktree: {},
      tabsByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      unifiedTabsByWorktree: {},
      folderWorkspaces: [],
      worktreesByRepo: {
        'repo-1': ['wt-1', 'wt-2', 'wt-3'].map((id) =>
          makeWorktree({ id, repoId: 'repo-1', path: '/repo', hostId: 'local' })
        ),
        'repo-ssh': [
          makeWorktree({ id: 'wt-ssh', repoId: 'repo-ssh', path: '/repo', hostId: 'ssh:target' })
        ]
      }
    })
  })

  afterEach(() => {
    assertEditorBufferInvariant(store.getState())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('gives two workspaces one record, model, draft and dirty flag', () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')

    type(store, a, 'typed in A')

    const state = store.getState()
    expect(a).not.toBe(b)
    expect(editorBufferIdOf(state, a)).toBe(editorBufferIdOf(state, b))
    expect(modelOwnerOf(store, a)).toBe(modelOwnerOf(store, b))
    expect(state.editorDrafts[b]).toBe('typed in A')
    expect(tab(store, b)?.isDirty).toBe(true)
    expect(Object.keys(state.editorBuffers)).toHaveLength(1)
  })

  it('lets a tab opened later join the unsaved record', () => {
    const a = openTab(store, 'wt-1')
    type(store, a, 'typed in A')

    const b = openTab(store, 'wt-2')

    expect(store.getState().editorDrafts[b]).toBe('typed in A')
    expect(tab(store, b)?.isDirty).toBe(true)
  })

  it('clears every tab when either one saves, writing once at a time', async () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, a, 'typed in A')
    const queue = createEditorSaveQueue(store)

    await Promise.all([
      queue.queueSave(tab(store, b)!, 'typed in A', 'user'),
      queue.queueSave(tab(store, a)!, 'typed in A', 'user')
    ])
    queue.dispose()

    expect(disk.files.get(FILE)).toBe('typed in A')
    expect(store.getState().editorDrafts).toEqual({})
    expect([tab(store, a)?.isDirty, tab(store, b)?.isDirty]).toEqual([false, false])
    expect(tab(store, a)?.lastKnownDiskSignature).toBe(tab(store, b)?.lastKnownDiskSignature)
  })

  it('flushes a delayed edit pending in another tab before saving', async () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, a, 'typed in A')
    const unregister = registerPendingEditorFlush(b, () => type(store, b, 'rich edit in B'))
    const queue = createEditorSaveQueue(store)

    await queue.queueSave(tab(store, a)!, 'typed in A', 'user')
    unregister()
    queue.dispose()

    expect(disk.files.get(FILE)).toBe('rich edit in B')
    expect(tab(store, a)?.isDirty).toBe(false)
  })

  it('two rich views flushed together: the newest edit wins and the other is recovered', () => {
    const a = openTab(store, 'wt-1', { filePath: '/repo/a.md', relativePath: 'a.md' })
    const b = openTab(store, 'wt-2', { filePath: '/repo/a.md', relativePath: 'a.md' })
    // Each serializes its own whole cached document, as the rich editor does.
    const richView = (id: string, text: string) => {
      const editedAt = nextEditorEditSequence()
      let pending = true
      return registerPendingEditorFlush(
        id,
        () => {
          if (pending) {
            pending = false
            type(store, id, text)
          }
        },
        undefined,
        () => (pending ? editedAt : null)
      )
    }
    const releaseB = richView(b, 'whole doc from B')
    const releaseA = richView(a, 'whole doc from A, edited last')

    flushEditorBufferViews(store.getState, a)
    releaseA()
    releaseB()

    expect(store.getState().editorDrafts[a]).toBe('whole doc from A, edited last')
    expect(store.getState().recoveredEditorDrafts).toMatchObject([
      { worktreeId: 'wt-2', draft: 'whole doc from B' }
    ])
  })

  it('runs one autosave timer for the record', async () => {
    vi.useFakeTimers()
    // Why re-stub: the window stub binds the timers that are current when it is created.
    disk = stubEditorWindowWithDisk()
    const a = openTab(store, 'wt-1')
    openTab(store, 'wt-2')
    type(store, a, 'typed in A')
    const queue = createEditorSaveQueue(store)

    queue.syncAutoSave()
    await vi.advanceTimersByTimeAsync(1000)
    queue.dispose()

    expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
    expect(disk.files.get(FILE)).toBe('typed in A')
  })

  it('marks every tab when the file changes on disk', () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')

    store.getState().setExternalMutation(b, 'changed')

    expect(tab(store, a)?.externalMutation).toBe('changed')
  })

  it('persists the shared draft for every tab so hot exit restores each', () => {
    const a = openTab(store, 'wt-1')
    openTab(store, 'wt-2')
    type(store, a, 'typed in A')
    const state = store.getState()

    const session = buildEditorSessionData(state.openFiles, state.editorDrafts, {}, {}, {})

    expect(session.openFilesByWorktree?.['wt-1']?.[0]?.dirtyDraftContent).toBe('typed in A')
    expect(session.openFilesByWorktree?.['wt-2']?.[0]?.dirtyDraftContent).toBe('typed in A')
  })

  it('prompts to save only when the last tab of a dirty record closes', () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, a, 'typed in A')

    expect(needsSavePromptOnClose(store.getState, a)).toBe(false)
    store.getState().closeFile(a)

    expect(store.getState().editorDrafts[b]).toBe('typed in A')
    expect(needsSavePromptOnClose(store.getState, b)).toBe(true)
  })

  it("discarding a tab that isn't the last only closes it", async () => {
    const { discardEditorFileChangesAndClose } =
      await import('@/components/editor/discard-editor-file-changes')
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, a, 'typed in A')

    await discardEditorFileChangesAndClose(a)

    expect(tab(store, a)).toBeUndefined()
    expect(tab(store, b)?.isDirty).toBe(true)
    expect(store.getState().editorDrafts[b]).toBe('typed in A')
  })

  it('shares autosave pauses, including with a tab that joins later', () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    store.getState().setPendingLiveDiskVerification(b, true)
    store.getState().setPendingDiskBaselineVerification(a, true)

    const c = openTab(store, 'wt-3')

    for (const id of [a, b, c]) {
      expect(tab(store, id)).toMatchObject({
        pendingLiveDiskVerification: true,
        pendingDiskBaselineVerification: true
      })
    }
    store.getState().clearPendingDiskBaselineVerification(c)
    expect(tab(store, a)?.pendingDiskBaselineVerification).toBeUndefined()
  })

  it("keeps newer edits typed in another tab while a closed tab's save was in flight", async () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, a, 'saved text')
    let finishWrite = (): void => {}
    disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        await new Promise<void>((resolve) => {
          finishWrite = resolve
        })
        disk.files.set(filePath, content)
      }
    )
    const queue = createEditorSaveQueue(store)

    const save = queue.queueSave(tab(store, a)!, 'saved text', 'user')
    await vi.waitFor(() => expect(disk.fs.writeFile).toHaveBeenCalled())
    store.getState().closeFile(a)
    type(store, b, 'newer text in B')
    finishWrite()
    await save
    queue.dispose()

    expect(disk.files.get(FILE)).toBe('saved text')
    expect(store.getState().editorDrafts[b]).toBe('newer text in B')
    expect(tab(store, b)?.isDirty).toBe(true)
  })

  it('a preview tab sharing unsaved edits stops being a preview and is never replaced', () => {
    const a = openTab(store, 'wt-1')
    const preview = openTab(store, 'wt-2', {}, { preview: true })
    expect(tab(store, preview)?.isPreview).toBe(true)

    type(store, a, 'typed in A')
    const joined = openTab(store, 'wt-3', {}, { preview: true })

    expect(tab(store, preview)?.isPreview).toBeUndefined()
    expect(tab(store, joined)).toMatchObject({ isPreview: undefined, isDirty: true })
    expect(getReplaceablePreviewFileId(store.getState(), 'wt-3', undefined)).toBeNull()
  })

  it("a queued save whose text a newer write already covered doesn't write its old fallback", async () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, a, 'draft X')
    let pending = true
    const unregister = registerPendingEditorFlush(b, () => {
      if (pending) {
        pending = false
        type(store, b, 'rich edit Y')
      }
    })
    const queue = createEditorSaveQueue(store)

    await Promise.all([
      queue.queueSave(tab(store, a)!, 'draft X', 'user'),
      queue.queueSave(tab(store, a)!, 'draft X', 'user')
    ])
    unregister()
    queue.dispose()

    expect(disk.files.get(FILE)).toBe('rich edit Y')
    expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
  })

  it('a save from a writable tab clears a read-only first tab of the same file', async () => {
    const readOnly = openTab(store, 'wt-1', { readOnly: true })
    const writable = openTab(store, 'wt-2')
    type(store, writable, 'typed')
    const queue = createEditorSaveQueue(store)

    await queue.queueSave(tab(store, writable)!, 'typed', 'user')
    queue.dispose()

    expect([tab(store, readOnly)?.isDirty, tab(store, writable)?.isDirty]).toEqual([false, false])
    expect(store.getState().editorDrafts).toEqual({})
  })

  it('closing a rich tab beside only a read-only view flushes first and then prompts', () => {
    const a = openTab(store, 'wt-1', { filePath: '/repo/a.md', relativePath: 'a.md' })
    openTab(store, 'wt-2', { filePath: '/repo/a.md', relativePath: 'a.md', readOnly: true })
    const unregister = registerPendingEditorFlush(a, () => type(store, a, 'typed in rich A'))

    expect(needsSavePromptOnClose(store.getState, a)).toBe(true)
    unregister()
  })

  it('closing a tab inside its rich-editor delay hands the pending text to its sibling', () => {
    const a = openTab(store, 'wt-1', { filePath: '/repo/a.md', relativePath: 'a.md' })
    const b = openTab(store, 'wt-2', { filePath: '/repo/a.md', relativePath: 'a.md' })
    // The rich editor has marked the file dirty but holds its serialization for 300 ms.
    store.getState().markFileDirty(a, true)
    const unregister = registerPendingEditorFlush(a, () => {
      if (store.getState().openFiles.some((file) => file.id === a)) {
        store.getState().setEditorDraft(a, 'typed in rich A')
      }
    })

    expect(needsSavePromptOnClose(store.getState, a)).toBe(false)
    store.getState().closeFile(a)
    unregister()

    expect(store.getState().editorDrafts[b]).toBe('typed in rich A')
    expect(tab(store, b)?.isDirty).toBe(true)
  })

  it('a tab queued to close behind its sibling leaves the prompt to the sibling', () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, a, 'typed in A')
    const closing = new Set([a, b])

    // Quit queues both: the first prompts, the second waits for that decision.
    expect(needsSavePromptOnClose(store.getState, a, closing)).toBe(true)
    expect(hasOtherSavingEditorView(store.getState(), a, closing)).toBe(false)
    expect(needsSavePromptOnClose(store.getState, a)).toBe(false)
  })

  function holdNextWrite(): () => void {
    let finish = (): void => {}
    disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        disk.files.set(filePath, content)
      }
    )
    return () => finish()
  }

  it('save-and-close superseded before it writes keeps the tab and its draft', async () => {
    openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, b, 'typed')
    const detach = attachEditorAutosaveController(store)

    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: b } })
    )
    // Staging the file quiesces its saves before the queued one runs.
    await requestEditorSaveQuiesce({ fileId: b })
    await new Promise((resolve) => setTimeout(resolve, 0))
    detach()

    expect(disk.fs.writeFile).not.toHaveBeenCalled()
    expect(tab(store, b)).toBeDefined()
    expect(store.getState().editorDrafts[b]).toBe('typed')
  })

  it('save-and-close keeps the tab when a sibling typed and closed while it wrote', async () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    type(store, a, 'first')
    const finishWrite = holdNextWrite()
    const detach = attachEditorAutosaveController(store)

    const onSettled = vi.fn()
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: a, onSettled } })
    )
    await vi.waitFor(() => expect(disk.fs.writeFile).toHaveBeenCalled())
    type(store, b, 'newer from B')
    store.getState().closeFile(b)
    finishWrite()
    await new Promise((resolve) => setTimeout(resolve, 0))
    detach()

    expect(tab(store, a)?.isDirty).toBe(true)
    expect(store.getState().editorDrafts[a]).toBe('newer from B')
    // The dialog closes at once without reporting a failure.
    expect(onSettled).toHaveBeenCalledWith('kept-open')
  })

  it("clearing a tab's owner-migration pause clears it for every tab of the file", () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    store.getState().setRestoredEditorOwnerMigrationPending(a, true)
    expect(tab(store, b)?.pendingOwnerMigration).toBe(true)

    store.setState((state) => ({
      ...rekeyEditorBuffers(state, new Map([[a, a]]), () => ({ pendingOwnerMigration: undefined }))
    }))

    expect(tab(store, a)?.pendingOwnerMigration).toBeUndefined()
    expect(tab(store, b)?.pendingOwnerMigration).toBeUndefined()
  })

  it('three differing drafts: the newest workspace wins and each other draft keeps its own owner', () => {
    for (const wt of ['wt-1', 'wt-2', 'wt-3']) {
      openTab(store, wt)
    }
    const ids = store.getState().openFiles.map((file) => file.id)
    store.setState((state) => ({
      activeWorktreeId: 'wt-1',
      activeFileId: null,
      activeFileIdByWorktree: Object.fromEntries(ids.map((id, i) => [`wt-${i + 1}`, `${id}-r`])),
      lastVisitedAtByWorktreeId: { 'wt-1': 100, 'wt-2': 200, 'wt-3': 300 },
      editorDrafts: Object.fromEntries(ids.map((id, i) => [`${id}-r`, `d${i + 1}`])),
      openFiles: state.openFiles.map((file) => ({ ...file, id: `${file.id}-r`, isDirty: true }))
    }))

    const state = store.getState()
    expect(new Set(Object.values(state.editorDrafts))).toEqual(new Set(['d3']))
    expect(
      state.recoveredEditorDrafts.map((entry) => [entry.worktreeId, entry.draft]).sort()
    ).toEqual([
      ['wt-1', 'd1'],
      ['wt-2', 'd2']
    ])
    expect(new Set(state.recoveredEditorDrafts.map((entry) => entry.id)).size).toBe(2)
  })

  it('credits a losing draft to its own workspace when the first tab had none', () => {
    for (const wt of ['wt-1', 'wt-2', 'wt-3']) {
      openTab(store, wt)
    }
    const ids = store.getState().openFiles.map((file) => file.id)
    store.setState((state) => ({
      activeWorktreeId: 'wt-1',
      activeFileId: null,
      activeFileIdByWorktree: Object.fromEntries(ids.map((id, i) => [`wt-${i + 1}`, `${id}-r`])),
      lastVisitedAtByWorktreeId: { 'wt-1': 100, 'wt-2': 200, 'wt-3': 300 },
      // wt-1 restores clean; wt-2 and wt-3 restore different drafts.
      editorDrafts: { [`${ids[1]}-r`]: 'd2', [`${ids[2]}-r`]: 'd3' },
      openFiles: state.openFiles.map((file, i) => ({
        ...file,
        id: `${file.id}-r`,
        isDirty: i > 0
      }))
    }))

    expect(
      store.getState().recoveredEditorDrafts.map((entry) => [entry.worktreeId, entry.draft])
    ).toEqual([['wt-2', 'd2']])
  })

  it('dismissing a recovered draft lets one held for this launch be kept across restarts', () => {
    const entries = Array.from({ length: 21 }, (_, i) => ({
      id: `r${i}`,
      filePath: `/repo/${i}.ts`,
      worktreeId: 'wt-1',
      draft: 'x',
      recoveredAt: i,
      ...(i === 0 ? { keptForThisLaunchOnly: true as const } : {})
    }))
    store.setState({ recoveredEditorDrafts: entries })

    store.getState().dismissRecoveredEditorDraft(entries[20])

    expect(
      store.getState().recoveredEditorDrafts.find((entry) => entry.id === 'r0')
        ?.keptForThisLaunchOnly
    ).toBeUndefined()
  })

  it('a read started before an external change can never replace what the change reloads', () => {
    const a = openTab(store, 'wt-1')
    const earlierRead = beginEditorBufferFileRead(store.getState(), a)

    notifyEditorExternalFileChange({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      relativePath: 'a.ts'
    })

    expect(earlierRead.isCurrent()).toBe(false)
  })

  it('two differing drafts keep the tab of the most recently visited workspace', () => {
    openTab(store, 'wt-1')
    openTab(store, 'wt-2')
    const [a, b] = store.getState().openFiles.map((file) => file.id)
    store.setState((state) => ({
      activeWorktreeId: 'wt-1',
      activeFileId: null,
      activeFileIdByWorktree: { 'wt-1': `${a}-r`, 'wt-2': `${b}-r` },
      lastVisitedAtByWorktreeId: { 'wt-1': 100, 'local|wt-2': 200 },
      editorDrafts: { [`${a}-r`]: 'from wt-1', [`${b}-r`]: 'from wt-2' },
      openFiles: state.openFiles.map((file) => ({ ...file, id: `${file.id}-r`, isDirty: true }))
    }))

    expect(store.getState().editorDrafts[`${a}-r`]).toBe('from wt-2')
    expect(store.getState().recoveredEditorDrafts).toMatchObject([{ draft: 'from wt-1' }])
  })

  it('a save superseded mid-write still rebaselines to the written text', async () => {
    const a = openTab(store, 'wt-1')
    type(store, a, 'draft one')
    const finishWrite = holdNextWrite()
    const queue = createEditorSaveQueue(store)

    const save = queue.queueSave(tab(store, a)!, 'draft one', 'user')
    await vi.waitFor(() => expect(disk.fs.writeFile).toHaveBeenCalled())
    queue.bumpSaveGeneration(a)
    finishWrite()
    queue.dispose()

    expect(await save).toBe('written')
    expect(tab(store, a)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('draft one'))
  })

  it("a read started by a tab that closed is delivered through the file's surviving tab", () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    const recordId = editorBufferIdOf(store.getState(), b)

    store.getState().closeFile(b)

    expect(liveEditorBufferViewOf(store.getState(), recordId)).toBe(a)
  })

  it('keeps the same path on another host separate', () => {
    const a = openTab(store, 'wt-1')
    const remote = openTab(store, 'wt-ssh')

    type(store, a, 'typed in A')
    store.getState().setExternalMutation(a, 'changed')

    expect(editorBufferViewIds(store.getState(), a)).toEqual([a])
    expect(modelOwnerOf(store, a)).not.toBe(modelOwnerOf(store, remote))
    expect(store.getState().editorDrafts[remote]).toBeUndefined()
    expect(tab(store, remote)?.isDirty).toBe(false)
    expect(tab(store, remote)?.externalMutation).toBeUndefined()
  })

  it('keeps paths that differ only in case apart', () => {
    const a = openTab(store, 'wt-1')
    const upper = openTab(store, 'wt-2', { filePath: '/repo/A.ts', relativePath: 'A.ts' })

    expect(editorBufferIdOf(store.getState(), a)).not.toBe(
      editorBufferIdOf(store.getState(), upper)
    )
  })

  it('a read-only tab mounting beside a dirty writable tab shows the edits', () => {
    const writable = openTab(store, 'wt-1')
    type(store, writable, 'typed in A')

    const readOnly = openTab(store, 'wt-2', { readOnly: true })
    store.getState().setEditorDraft(readOnly, 'read-only typing')

    expect(store.getState().editorDrafts[readOnly]).toBe('typed in A')
    expect(modelOwnerOf(store, readOnly)).toBe(modelOwnerOf(store, writable))
    // The read-only tab can't save, so the writable one still asks before closing.
    expect(needsSavePromptOnClose(store.getState, writable)).toBe(true)
    expect(needsSavePromptOnClose(store.getState, readOnly)).toBe(false)
  })

  it('a provisional tab joins its file once its owner resolves; its edits win', () => {
    const resolved = openTab(store, 'wt-1')
    const provisional = openTab(store, 'wt-late')
    type(store, provisional, 'typed before the owner resolved')
    expect(editorBufferIdOf(store.getState(), provisional)).not.toBe(
      editorBufferIdOf(store.getState(), resolved)
    )

    store.setState({
      worktreesByRepo: {
        ...store.getState().worktreesByRepo,
        'repo-late': [
          makeWorktree({ id: 'wt-late', repoId: 'repo-late', path: '/repo', hostId: 'local' })
        ]
      }
    })

    expect(editorBufferIdOf(store.getState(), provisional)).toBe(
      editorBufferIdOf(store.getState(), resolved)
    )
    expect(store.getState().editorDrafts[resolved]).toBe('typed before the owner resolved')
    expect(tab(store, resolved)?.isDirty).toBe(true)
  })

  describe('two different drafts of one file (only an older session can hold them)', () => {
    it("on owner resolution, the active tab's draft wins and the other is recovered", () => {
      const resolved = openTab(store, 'wt-1')
      type(store, resolved, 'edit in the resolved tab')
      const provisional = openTab(store, 'wt-late')
      type(store, provisional, 'edit in the provisional tab')
      store.setState({ activeFileId: provisional })

      store.setState({
        worktreesByRepo: {
          ...store.getState().worktreesByRepo,
          'repo-late': [
            makeWorktree({ id: 'wt-late', repoId: 'repo-late', path: '/repo', hostId: 'local' })
          ]
        }
      })

      const state = store.getState()
      expect(editorBufferIdOf(state, provisional)).toBe(editorBufferIdOf(state, resolved))
      expect(state.editorDrafts[resolved]).toBe('edit in the provisional tab')
      expect(state.recoveredEditorDrafts).toMatchObject([
        { filePath: FILE, draft: 'edit in the resolved tab' }
      ])
    })

    it.each([
      ['differ', 'draft in wt-1', 'draft in wt-2', 1],
      ['match', 'same draft', 'same draft', 0]
    ])('restored legacy drafts that %s share one record', (_label, first, second, recovered) => {
      const restore = (worktreeId: string, draft: string) => ({
        filePath: FILE,
        relativePath: 'a.ts',
        worktreeId,
        language: 'typescript',
        dirtyDraftContent: draft,
        lastKnownDiskSignature: 'sig-disk'
      })

      store.getState().hydrateEditorSession({
        activeRepoId: null,
        activeWorktreeId: 'wt-1',
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        openFilesByWorktree: {
          'wt-1': [restore('wt-1', first)],
          'wt-2': [restore('wt-2', second)]
        }
      })

      const state = store.getState()
      const [a, b] = state.openFiles.map((file) => file.id)
      expect(Object.keys(state.editorBuffers)).toHaveLength(1)
      expect(state.editorDrafts[a]).toBe(state.editorDrafts[b])
      expect(state.recoveredEditorDrafts).toHaveLength(recovered)
      const kept = new Set([
        state.editorDrafts[a],
        ...state.recoveredEditorDrafts.map((entry) => entry.draft)
      ])
      expect(kept).toEqual(new Set([first, second]))
    })

    it('on a rename onto a file with other unsaved edits, the other draft is recovered', () => {
      const target = openTab(store, 'wt-2', { filePath: '/repo/b.ts', relativePath: 'b.ts' })
      type(store, target, 'unsaved b')
      const moved = openTab(store, 'wt-1')
      type(store, moved, 'unsaved a')

      const result = store.getState().rekeyOpenFilesForPathChange({
        rekeys: [
          {
            oldFileId: moved,
            newFileId: `${moved}-renamed`,
            oldFilePath: FILE,
            newFilePath: '/repo/b.ts',
            newRelativePath: 'b.ts'
          }
        ]
      })

      const state = store.getState()
      expect(result).toEqual({ ok: true })
      expect(editorBufferIdOf(state, `${moved}-renamed`)).toBe(editorBufferIdOf(state, target))
      expect(state.editorDrafts[target]).toBe('unsaved a')
      expect(state.recoveredEditorDrafts).toMatchObject([
        { filePath: '/repo/b.ts', draft: 'unsaved b' }
      ])
    })
  })
})
