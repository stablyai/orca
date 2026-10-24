// @vitest-environment happy-dom
// Why: G3 scenarios through the real record middleware and save queue, with two workspaces showing
// one file: restored drafts, phone saves, delayed rich text and paused autosave.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  getOpenFilesForExternalFileChange,
  isAutosaveSuspendedForFile,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  requestEditorFileSave,
  type EditorFileSavedDetail
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { GUARDED_PATH, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { editorTabModelUri } from './editor-save-disk-precondition'
import { mayPushTabTextIntoModel, isStaleCachedEditorText } from './editor-stale-mount-guard'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { isDetachedEditorBufferId } from '@/store/slices/editor/buffers/editor-buffer-views'
import { buildHydratedEditorSessionState } from '@/store/slices/editor/actions/hydrated-editor-session-state'
import { stampCleanTabDiskBaseline } from './editor-clean-tab-disk-baseline'
import { withRecordDiskText } from './editor-buffer-adapter'
import { ExternalFileChangeBanner } from './ExternalFileChangeBanner'
import type { FileContent } from './editor-panel-content-types'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => {
  const getState = () => storeRef.current!.getState()
  return {
    useAppStore: Object.assign((select: (state: AppState) => unknown) => select(getState()), {
      getState
    })
  }
})
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))

const BASE = 'base'

function twoWorkspaceStore(): StoreApi<AppState> {
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
  return store
}

function restore(store: StoreApi<AppState>, drafts: [string, string]): [OpenFile, OpenFile] {
  const entry = (worktreeId: string, draft: string) => ({
    filePath: GUARDED_PATH,
    relativePath: 'file.ts',
    worktreeId,
    language: 'typescript',
    dirtyDraftContent: draft,
    lastKnownDiskSignature: getDiskBaselineSignature(BASE)
  })
  const session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: 'wt-1',
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: { 'wt-1': [entry('wt-1', drafts[0])], 'wt-2': [entry('wt-2', drafts[1])] }
  }
  // The store write session hydration makes.
  store.setState(buildHydratedEditorSessionState(session, new Set(['wt-1', 'wt-2']), 'wt-1').state)
  const [a, b] = store.getState().openFiles
  expect([a?.worktreeId, b?.worktreeId]).toEqual(['wt-1', 'wt-2'])
  return [a, b]
}

/**
 * What a mount does with the view's text (its draft, else the panel's cached `text`): create its
 * model, or push into one it may overwrite. Stale cached text never enters a live model.
 */
function mount(
  store: StoreApi<AppState>,
  viewId: string,
  text = store.getState().editorDrafts[viewId] ?? BASE
): monaco.editor.ITextModel {
  const state = store.getState()
  const file = state.openFiles.find((tab) => tab.id === viewId)!
  const uri = monaco.Uri.parse(editorTabModelUri(state, file))
  const model = monaco.editor.getModel(uri)
  if (!model) {
    return monaco.editor.createModel(text, 'typescript', uri)
  }
  if (
    model.getValue() !== text &&
    !isStaleCachedEditorText(viewId, text) &&
    mayPushTabTextIntoModel(viewId)
  ) {
    model.setValue(text)
  }
  return model
}

/** The banner an edit surface shows for a view: only while its record is conflicted. */
function bannerOf(store: StoreApi<AppState>, id: string): string | null {
  const file = view(store, id)!
  return file.externalMutation === 'changed'
    ? renderToStaticMarkup(
        createElement(ExternalFileChangeBanner, {
          file,
          currentContent: store.getState().editorDrafts[id] ?? BASE,
          reloadContent: () => {}
        })
      )
    : null
}

const view = (store: StoreApi<AppState>, id: string) =>
  store.getState().openFiles.find((tab) => tab.id === id)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __clearSelfWriteRegistryForTests()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

describe('restored drafts of one file (scenario 2)', () => {
  it.each([['a first'], ['b first'], ['no mount']] as const)(
    'divergent drafts detach with their own models (%s); the first autosave lands and the other side keeps its draft behind the banner',
    async (order) => {
      const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
      const store = twoWorkspaceStore()
      const [a, b] = restore(store, ['abc', 'abcd'])
      const recordOf = (id: string) => store.getState().editorBufferIdOf[id]
      expect(isDetachedEditorBufferId(recordOf(b.id))).toBe(true)

      if (order !== 'no mount') {
        const ids = order === 'a first' ? [a.id, b.id] : [b.id, a.id]
        const models: monaco.editor.ITextModel[] = []
        for (const id of ids) {
          models.push(mount(store, id))
        }
        expect(models[0]).not.toBe(models[1])
        expect(mount(store, a.id).getValue()).toBe('abc')
        expect(mount(store, b.id).getValue()).toBe('abcd')
      }

      const cleanup = attachEditorAutosaveController(store)
      try {
        await vi.advanceTimersByTimeAsync(5000)
        // One write landed; the other was refused against the restored baseline.
        const landed = disk.files.get(GUARDED_PATH)
        expect(['abc', 'abcd']).toContain(landed)
        const kept = landed === 'abc' ? 'abcd' : 'abc'
        expect(disk.writeFile).toHaveBeenCalledTimes(2)
        // Rejoined: the unsaved side won with its old baseline, banner on every view.
        expect(recordOf(a.id)).toBe(recordOf(b.id))
        for (const id of [a.id, b.id]) {
          expect(store.getState().editorDrafts[id]).toBe(kept)
          expect(view(store, id)?.isDirty).toBe(true)
          expect(view(store, id)?.externalMutation).toBe('changed')
          expect(view(store, id)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature(BASE))
        }
      } finally {
        cleanup()
      }
    }
  )

  it('identical drafts merge into one record and write once', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const store = twoWorkspaceStore()
    const [a, b] = restore(store, ['same', 'same'])
    expect(store.getState().editorBufferIdOf[a.id]).toBe(store.getState().editorBufferIdOf[b.id])
    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(5000)
      expect(disk.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.get(GUARDED_PATH)).toBe('same')
      expect(view(store, a.id)?.isDirty).toBe(false)
      expect(view(store, b.id)?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })
})

function openShared(disk: string) {
  const store = twoWorkspaceStore()
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
  store.getState().setLastKnownDiskSignature(a.id, getDiskBaselineSignature(disk))
  return { store, a, b }
}

describe('two workspaces on one record', () => {
  it('W1 "abc", W2 "d": one write of "abcd"; old W1 text never reaches the model (scenario 1)', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const { store, a, b } = openShared(BASE)
    const model = mount(store, a.id)
    expect(mount(store, b.id)).toBe(model)
    // Typing in each workspace edits the one model; each view's editor publishes the draft.
    model.setValue('abc')
    store.getState().setEditorDraft(a.id, 'abc')
    store.getState().markFileDirty(a.id, true)
    model.setValue('abcd')
    store.getState().setEditorDraft(b.id, 'abcd')
    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(5000)
      expect(disk.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.get(GUARDED_PATH)).toBe('abcd')
      expect(view(store, a.id)?.isDirty).toBe(false)
      expect(view(store, b.id)?.isDirty).toBe(false)
      // W1 remounting with its panel's old cached text pushes nothing.
      expect(mount(store, a.id, 'abc')).toBe(model)
      expect(model.getValue()).toBe('abcd')
    } finally {
      cleanup()
    }
  })

  it.each([
    ['dirty', 'banners every view'],
    ['clean', 'reloads every view']
  ] as const)('a phone save on a %s record %s (scenario 4)', async (state, _outcome) => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: 'from phone' })
    const { store, a, b } = openShared(BASE)
    if (state === 'dirty') {
      store.getState().setEditorDraft(a.id, 'desktop edits')
      store.getState().markFileDirty(a.id, true)
    }
    const cleanup = attachEditorAutosaveController(store)
    try {
      const detail = { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'file.ts' }
      window.dispatchEvent(new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, { detail }))
      for (const id of [a.id, b.id]) {
        if (state === 'dirty') {
          expect(view(store, id)?.externalMutation).toBe('changed')
          expect(store.getState().editorDrafts[id]).toBe('desktop edits')
        } else {
          expect(view(store, id)?.isDirty).toBe(false)
          expect(store.getState().editorDrafts[id]).toBeUndefined()
        }
      }
      if (state === 'clean') {
        // The panel reloads every tab this matches: content and clean baseline from disk.
        const matched = getOpenFilesForExternalFileChange(store.getState().openFiles, {
          worktreeId: 'wt-2',
          worktreePath: '/repo',
          relativePath: 'file.ts'
        }).map((file) => file.id)
        expect(matched).toContain(b.id)
        let contents: Record<string, FileContent> = {}
        for (const id of [a.id, b.id]) {
          const loaded = { content: disk.files.get(GUARDED_PATH)!, isBinary: false }
          stampCleanTabDiskBaseline(id, loaded)
          contents = { ...contents, [id]: loaded }
        }
        expect(view(store, b.id)?.lastKnownDiskSignature).toBe(
          getDiskBaselineSignature('from phone')
        )

        // A desktop save after it lands, and the panel moves the other view to the written text.
        const saved: EditorFileSavedDetail[] = []
        window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, (event) => {
          if (event instanceof CustomEvent) {
            saved.push(event.detail)
          }
        })
        store.getState().setEditorDraft(a.id, 'from phone, then desktop')
        store.getState().markFileDirty(a.id, true)
        await requestEditorFileSave({ fileId: a.id })
        expect(disk.files.get(GUARDED_PATH)).toBe('from phone, then desktop')
        const [detail] = saved
        contents = withRecordDiskText(
          contents,
          detail.recordViewIds ?? [],
          detail.fileId,
          detail.content
        )
        expect(contents[b.id]?.content).toBe('from phone, then desktop')
      }
    } finally {
      cleanup()
    }
  })

  it("a save writes another view's pending rich text; typing during the save stays dirty (scenario 5)", async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const { store, a, b } = openShared(BASE)
    store.getState().setEditorDraft(a.id, 'source')
    store.getState().markFileDirty(a.id, true)
    let pending: string | null = 'source, rich'
    const unregister = registerPendingEditorFlush(b.id, () => {
      if (pending !== null) {
        store.getState().setEditorDraft(b.id, pending)
        pending = null
      }
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: a.id })
      expect(disk.files.get(GUARDED_PATH)).toBe('source, rich')
      expect(view(store, b.id)?.isDirty).toBe(false)
    } finally {
      unregister()
      cleanup()
    }
  })

  it('a conflicted record pauses autosave on every view; a detached pair shows its own (scenario 8)', () => {
    stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const { store, a, b } = openShared(BASE)
    store.getState().setEditorDraft(a.id, 'mine')
    store.getState().markFileDirty(a.id, true)
    store.getState().setExternalMutation(b.id, 'changed')
    for (const id of [a.id, b.id]) {
      expect(isAutosaveSuspendedForFile(view(store, id)!)).toBe(true)
      // Both views render the banner, offering to overwrite with the record's edits.
      expect(bannerOf(store, id)).toContain('changed on disk')
      expect(bannerOf(store, id)).toContain('>Overwrite<')
    }

    const pair = twoWorkspaceStore()
    const [c, d] = restore(pair, ['abc', 'abcd'])
    pair.getState().setExternalMutation(d.id, 'changed')
    expect(isAutosaveSuspendedForFile(view(pair, d.id)!)).toBe(true)
    expect(isAutosaveSuspendedForFile(view(pair, c.id)!)).toBe(false)
    expect(bannerOf(pair, d.id)).toContain('changed on disk')
    expect(bannerOf(pair, c.id)).toBeNull()
  })
})
