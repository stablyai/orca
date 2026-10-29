// @vitest-environment happy-dom
// When a shared record goes clean, synchronize source and rich views so stale typing cannot resurrect old text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { editorTabModelUri } from './editor-save-disk-precondition'
import { useEditorContentChangeHandler } from './use-editor-content-change-handler'
import { useMonacoContentSyncBridge } from './use-monaco-content-sync-bridge'
import type { FileContent } from './editor-panel-content-types'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))
vi.mock('@/store', () => {
  const getState = () => storeRef.current!.getState()
  return {
    useAppStore: Object.assign((select: (state: AppState) => unknown) => select(getState()), {
      getState
    })
  }
})

const PATH = '/repo/notes.md'
const DISK = '# notes\n\nhello\n'
// What a rich view commits for the saved document: the same text but for trailing whitespace.
const RICH_SAVED = '# notes\n\nhello'

let unregister: () => void = () => {}
beforeEach(() => {
  unregister = editorModelRegistry.register(monaco)
})
afterEach(() => {
  unregister()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

function openSharedMarkdown() {
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
      filePath: PATH,
      relativePath: 'notes.md',
      worktreeId,
      language: 'markdown',
      mode: 'edit'
    })
  }
  const [a, b] = store.getState().openFiles
  store.getState().setLastKnownDiskSignature(a.id, getDiskBaselineSignature(DISK))
  store.getState().setMarkdownViewMode(a.id, 'source')
  store.getState().setMarkdownViewMode(b.id, 'rich')
  const state = store.getState()
  const model = monaco.editor.createModel(
    DISK,
    'markdown',
    monaco.Uri.parse(editorTabModelUri(state, a))
  )
  // A's source editor shows the model, so record commits from B reach it through A's content sync.
  vi.spyOn(model, 'isAttachedToEditor').mockReturnValue(true)
  const fileContents: Record<string, FileContent> = {
    [a.id]: { content: DISK, isBinary: false },
    [b.id]: { content: DISK, isBinary: false }
  }
  const commit = renderHook(() => useEditorContentChangeHandler({ fileContents, diffContents: {} }))
    .result.current
  const viewText = (id: string): string =>
    store.getState().editorDrafts[id] ?? fileContents[id].content
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: content sync only calls getModel and pushUndoStop.
  const editorA = {
    getModel: () => model,
    pushUndoStop: () => true
  } as unknown as editor.IStandaloneCodeEditor
  const contentRef = { current: viewText(a.id) }
  const bridge = renderHook(
    ({ content }: { content: string }) =>
      useMonacoContentSyncBridge({
        editorRef: { current: editorA },
        content,
        contentRef,
        contentSyncModeRef: { current: 'undoable' },
        modelKey: model.uri.toString(),
        fileId: a.id,
        onContentChange: (text) => commit(store.getState().openFiles[0], text)
      }),
    { initialProps: { content: viewText(a.id) } }
  )
  const renderA = (): void => {
    contentRef.current = viewText(a.id)
    bridge.rerender({ content: viewText(a.id) })
  }
  const typeInA = (text: string): void => {
    act(() => {
      model.setValue(text)
      bridge.result.current.handleChange(text)
    })
    renderA()
  }
  const commitFromB = (text: string): void => {
    act(() => commit(store.getState().openFiles[1], text))
    renderA()
  }
  const view = (id: string) => store.getState().openFiles.find((tab) => tab.id === id)!
  return { store, a: a.id, b: b.id, model, typeInA, commitFromB, view }
}

describe('a record that goes clean shows its text in every view', () => {
  it.each([
    ['differs only in trailing whitespace', RICH_SAVED],
    ['matches disk exactly', DISK]
  ])(
    'rich undo back to the saved text (%s) reaches the source view; typing there keeps no undone text',
    (_label, richSaved) => {
      const { store, a, b, model, typeInA, commitFromB, view } = openSharedMarkdown()
      typeInA(`${DISK}XYZ`)
      expect(view(b).isDirty).toBe(true)

      commitFromB(richSaved)
      expect(view(a).isDirty).toBe(false)
      expect(view(b).isDirty).toBe(false)
      expect(model.getValue()).toBe(richSaved)

      typeInA(`${model.getValue()}Q`)
      expect(store.getState().editorDrafts[a]).not.toContain('XYZ')
    }
  )
})
