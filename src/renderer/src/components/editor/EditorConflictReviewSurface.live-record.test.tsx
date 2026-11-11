// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { PendingEditorReveal } from '@/store/slices/editor/types/pending-editor-reveal'
import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createEditorStore } from './autosave/editor-autosave-controller-test-fixture'
import { createEditorPanelDraftSelector } from './editor-panel-draft-selector'

import { EditorConflictReviewSurface } from './EditorConflictReviewSurface'

type MonacoProps = {
  fileId: string
  filePath: string
  content: string
  readOnly?: boolean
  worktreeId?: string
  passiveMirror?: boolean
  revealLine?: number
  viewStateId?: string
  onContentChange: (content: string) => void
  onSave: (content: string) => void
}

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))
const monacoMounts = vi.hoisted((): { current: MonacoProps[] } => ({ current: [] }))
const retries = vi.hoisted((): { current: (() => void)[] } => ({ current: [] }))

vi.mock('@/store', () => {
  const getState = () => storeRef.current!.getState()
  return {
    useAppStore: Object.assign((select: (state: AppState) => unknown) => select(getState()), {
      getState
    })
  }
})
vi.mock('./editor-lazy-views', () => ({
  ImageViewer: () => null,
  MonacoEditor: (props: MonacoProps) => {
    monacoMounts.current.push(props)
    return null
  }
}))
vi.mock('./EditorFileLoadErrorView', () => ({
  EditorFileLoadErrorView: ({ onRetry }: { onRetry: () => void }) => {
    retries.current.push(onRetry)
    return null
  }
}))
vi.mock('./ConflictComponents', () => ({
  ConflictBanner: () => null,
  ConflictPlaceholderView: () => null,
  ConflictReviewPanel: ({ selectedContent }: { selectedContent: React.ReactNode }) =>
    selectedContent
}))

const PATH = '/repo/file.ts'
const ENTRY: GitStatusEntry = {
  path: 'file.ts',
  status: 'modified',
  area: 'unstaged',
  conflictKind: 'both_modified',
  conflictStatus: 'unresolved',
  conflictStatusSource: 'git'
}

let root: Root | null = null

function setup(): { store: StoreApi<AppState>; view: OpenFile; review: OpenFile } {
  const store = createEditorStore()
  storeRef.current = store
  store.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    },
    browserTabsByWorktree: {},
    tabsByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  store.getState().openFile({
    filePath: PATH,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store
    .getState()
    .openConflictReview(
      'wt-2',
      '/repo',
      [{ path: 'file.ts', conflictKind: 'both_modified' }],
      'live-summary'
    )
  const [view, review] = store.getState().openFiles
  expect(review.mode).toBe('conflict-review')
  return { store, view, review }
}

type RenderOptions = {
  loadError?: string
  pendingEditorReveal?: PendingEditorReveal | null
  reloadContent?: (file: OpenFile) => void
}

function render(
  store: StoreApi<AppState>,
  review: OpenFile,
  diskText: string,
  options: RenderOptions = {}
): MonacoProps {
  const editBuffers = createEditorPanelDraftSelector(review)(store.getState())
  const viewIds = store.getState().openFiles.map((file) => file.id)
  const fileContents = Object.fromEntries(
    [...viewIds, PATH].map((id) => [
      id,
      { content: diskText, isBinary: false, loadError: options.loadError }
    ])
  )
  monacoMounts.current = []
  retries.current = []
  act(() => {
    root!.render(
      createElement(EditorConflictReviewSurface, {
        activeFile: review,
        viewStateScopeId: 'panel-1',
        fileContents,
        editBuffers,
        openFiles: store.getState().openFiles,
        worktreeEntries: [ENTRY],
        pendingEditorReveal: options.pendingEditorReveal ?? null,
        getConflictNavigation: () => undefined,
        handleContentChangeForFile: (file, content) =>
          store.getState().setEditorDraft(file.id, content),
        handleSaveForFile: async () => true,
        reloadContent: options.reloadContent ?? (() => {})
      })
    )
  })
  if (options.loadError) {
    expect(retries.current).toHaveLength(1)
    return monacoMounts.current[0]
  }
  expect(monacoMounts.current).toHaveLength(1)
  return monacoMounts.current[0]
}

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
})

describe('conflict-review overview as a live read-only view of the record', () => {
  it("can't edit or save the record", () => {
    const { store, view, review } = setup()
    store.getState().setEditorDraft(view.id, 'unsaved')
    store.getState().markFileDirty(view.id, true)
    const before = store.getState()

    const overview = render(store, review, 'disk')
    overview.onContentChange('typed in overview')
    overview.onSave('typed in overview')
    expect(store.getState().editorDrafts).toBe(before.editorDrafts)
    expect(store.getState().openFiles).toBe(before.openFiles)
  })

  it('closing it leaves the record, its draft and its views alone', () => {
    const { store, view, review } = setup()
    store.getState().setEditorDraft(view.id, 'unsaved')
    store.getState().markFileDirty(view.id, true)
    render(store, review, 'disk')
    const recordId = store.getState().editorBufferIdOf[view.id]
    expect(store.getState().editorBufferIdOf[review.id]).not.toBe(recordId)

    act(() => root!.unmount())
    root = createRoot(document.createElement('div'))
    store.getState().closeFile(review.id)

    const state = store.getState()
    expect(state.openFiles.map((file) => file.id)).toEqual([view.id])
    expect(state.editorBufferViews[recordId]).toEqual([view.id])
    expect(state.editorDrafts[view.id]).toBe('unsaved')
    expect(state.openFiles[0].isDirty).toBe(true)
    expect(state.editorBufferKept).toEqual({})
  })
})
