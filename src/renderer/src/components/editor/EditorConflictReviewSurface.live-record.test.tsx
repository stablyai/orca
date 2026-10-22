// @vitest-environment happy-dom
// Why: the conflict-review overview is a read-only live view of the file's shared record (G4).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile, PendingEditorReveal } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { createEditorPanelDraftSelector } from './editor-panel-draft-selector'
import { editorTabModelUri } from './editor-save-disk-precondition'
import { EditorConflictReviewSurface } from './EditorConflictReviewSurface'

type MonacoProps = {
  fileId: string
  filePath: string
  content: string
  readOnly?: boolean
  worktreeId?: string
  passiveMirror?: boolean
  revealLine?: number
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

/** Renders the overview as the panel does: drafts through the panel's draft selector. */
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
  it("shows the record's unsaved text from another workspace's view, on that record's model", () => {
    const { store, view, review } = setup()
    store.getState().setEditorDraft(view.id, 'unsaved')
    store.getState().markFileDirty(view.id, true)

    const overview = render(store, review, 'disk')
    expect(overview.content).toBe('unsaved')
    expect(overview.readOnly).toBe(true)
    expect(overview.fileId).toBe(view.id)
    const state = store.getState()
    const overviewView = state.openFiles.find((file) => file.id === overview.fileId)!
    expect(editorTabModelUri(state, { ...overviewView, filePath: overview.filePath })).toBe(
      editorTabModelUri(state, view)
    )
  })

  it('follows typing in another view of the file', () => {
    const { store, view, review } = setup()
    expect(render(store, review, 'disk').content).toBe('disk')

    store.getState().setEditorDraft(view.id, 'a')
    store.getState().markFileDirty(view.id, true)
    expect(render(store, review, 'disk').content).toBe('a')
    store.getState().setEditorDraft(view.id, 'ab')
    expect(render(store, review, 'disk').content).toBe('ab')
  })

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

  it('shows disk text when no view holds the file', () => {
    const { store, view, review } = setup()
    store.getState().closeFile(view.id)
    const overview = render(store, review, 'disk')
    expect(overview.fileId).toBe(PATH)
    expect(overview.content).toBe('disk')
  })

  it("retries a failed read through the borrowed view's own workspace", () => {
    const { store, view, review } = setup()
    const reloadContent = vi.fn()
    render(store, review, 'disk', { loadError: 'denied', reloadContent })
    retries.current[0]()
    expect(reloadContent).toHaveBeenCalledWith(view)
  })

  it("mounts as a passive mirror: the view's workspace, no cursor tracking, no reveals", () => {
    const { store, view, review } = setup()
    const overview = render(store, review, 'disk', {
      pendingEditorReveal: { fileId: view.id, filePath: PATH, line: 9, column: 1, matchLength: 0 }
    })
    expect(overview.worktreeId).toBe('wt-1')
    expect(overview.passiveMirror).toBe(true)
    expect(overview.revealLine).toBeUndefined()
  })
})
