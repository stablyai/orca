// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import { createEditorModelRegistry } from '@/lib/editor/monaco/editor-model-registry'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createEditorStore } from '../../autosave/editor-autosave-controller-test-fixture'
import { applyEditorBufferText } from './editor-buffer-adapter'

import { editorTabModelUri } from '../../save/queue/editor-save-disk-precondition'
import { attachClosedEditorTabCleanup } from '../retention/closed-editor-tab-controller'

import { showClosedUnsavedFilesToast } from '../../closed-unsaved-files-toast'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))
const toastWarning = vi.hoisted(() => vi.fn())
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('sonner', () => ({ toast: { warning: toastWarning, dismiss: vi.fn(), error: vi.fn() } }))

const PATH = '/repo/notes.md'
const bridge = createEditorModelRegistry()
bridge.register(monaco)

function twoViews(): { store: StoreApi<AppState>; a: string; b: string } {
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
      relativePath: 'notes.md',
      worktreeId,
      language: 'markdown',
      mode: 'edit'
    })
  }
  const [a, b] = store.getState().openFiles
  return { store, a: a.id, b: b.id }
}

function modelOf(
  store: StoreApi<AppState>,
  viewId: string,
  text = 'disk'
): monaco.editor.ITextModel {
  const state = store.getState()
  const file = state.openFiles.find((tab) => tab.id === viewId)!
  const uri = monaco.Uri.parse(editorTabModelUri(state, file))
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, 'markdown', uri)
}

const file = (store: StoreApi<AppState>, id: string) =>
  store.getState().openFiles.find((tab) => tab.id === id)!

afterEach(() => {
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

describe('applyEditorBufferText', () => {
  let store: StoreApi<AppState>
  let a: string
  let b: string
  beforeEach(() => {
    ;({ store, a, b } = twoViews())
    store.getState().setMarkdownViewMode(a, 'source')
  })

  it('makes each commit its own undo step, apart from typing before it', () => {
    const model = modelOf(store, a)
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'typed' }], () => null)
    applyEditorBufferText(store.getState(), file(store, b), 'first commit', bridge)
    applyEditorBufferText(store.getState(), file(store, b), 'second commit', bridge)
    model.undo()
    expect(model.getValue()).toBe('first commit')
    model.undo()
    expect(model.getValue()).toBe('typed')
  })
})

describe('a kept dirty record owns its model', () => {
  it('keeps the model past its last view until its removal notice is dismissed', async () => {
    const { store, a, b } = twoViews()
    storeRef.current = store
    store.setState((s) => ({ openFiles: s.openFiles.filter((tab) => tab.id !== b) }))
    store.getState().setEditorDraft(a, 'unsaved')
    store.getState().markFileDirty(a, true)
    const model = modelOf(store, a, 'unsaved')
    const detach = attachClosedEditorTabCleanup(store, bridge)
    try {
      store.setState((s) => ({
        openFiles: s.openFiles.filter((tab) => tab.id !== a),
        editorBufferKeepRequest: { viewIds: new Set([a]), notice: 1 }
      }))
      await Promise.resolve()
      await Promise.resolve()
      expect(model.isDisposed()).toBe(false)

      showClosedUnsavedFilesToast([{ fileId: a, filePath: PATH, content: 'unsaved' }], 'wt-1', 1)
      toastWarning.mock.calls[0][1].onDismiss()
      expect(store.getState().editorBufferKept).toEqual({})
      await Promise.resolve()
      await Promise.resolve()
      expect(model.isDisposed()).toBe(true)
    } finally {
      detach()
    }
  })
})
