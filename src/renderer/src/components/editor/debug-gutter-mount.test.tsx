// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import type { OnMount } from '@monaco-editor/react'
import type { MonacoEditorMountParams } from './monaco-editor-mount-params'
import { useMonacoEditorMount } from './use-monaco-editor-mount'

const { connectDebugEditor, debugDispose } = vi.hoisted(() => {
  const debugDispose = vi.fn()
  return {
    debugDispose,
    connectDebugEditor: vi.fn(() => ({ dispose: debugDispose }))
  }
})

vi.mock('@/lib/debug/connect-debug-editor', () => ({ connectDebugEditor }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      pendingEditorReveal: null,
      pendingEditorFocusRequest: null
    })
  }
}))
vi.mock('./monaco-markdown-doc-link-decorations', () => ({
  createMarkdownDocLinkDecorationController: vi.fn()
}))
vi.mock('./monaco-markdown-doc-completions', () => ({
  ensureMarkdownDocCompletionProvider: vi.fn()
}))
vi.mock('./monaco-e2e-probe', () => ({ installMonacoE2EProbe: () => vi.fn() }))
vi.mock('./monaco-editor-input-bindings', () => ({
  installMonacoEditorInputBindings: () => ({ disposeInputBindings: vi.fn() })
}))
vi.mock('./monaco-view-state-persistence', () => ({
  installMonacoViewStateTracking: () => ({
    cursorPositionSub: { dispose: vi.fn() },
    scrollStateSub: { dispose: vi.fn() }
  }),
  restoreMonacoViewState: vi.fn()
}))

beforeEach(() => {
  connectDebugEditor.mockClear()
  debugDispose.mockClear()
})
afterEach(cleanup)

function mountParams(worktreeId: string | undefined): MonacoEditorMountParams {
  return {
    fileId: 'file-1',
    filePath: '/repo/app.py',
    viewStateKey: 'view',
    viewStateId: 'view',
    worktreeId,
    autoHeight: false,
    autoHeightLineHeight: 20,
    editorRef: { current: null },
    editorContainerRef: { current: null },
    languageRef: { current: 'python' },
    propsRef: {
      current: {
        relativePath: 'app.py',
        language: 'python',
        onSave: vi.fn(),
        onContentChange: vi.fn()
      }
    },
    readOnlyRef: { current: false },
    scrollThrottleTimerRef: { current: null },
    unregisterFileSearchSelectionRef: { current: null },
    setMountedEditor: vi.fn(),
    setAutoHeightContentHeight: vi.fn(),
    setEditorCursorLine: vi.fn(),
    setupCopy: vi.fn(),
    queueReveal: vi.fn(),
    contentSync: {
      contentRef: { current: '' },
      lastSyncedContentRef: { current: '' },
      contentSyncModeRef: { current: 'undoable' },
      isApplyingProgrammaticContentRef: { current: false },
      isApplyingLargePasteRef: { current: false }
    },
    decorations: {
      markdownDocLinkDecorationsRef: { current: null },
      conflictDecorationsRef: { current: null },
      updateMarkdownCompletionDocuments: vi.fn()
    },
    annotations: {
      commentPopoverRef: { current: null },
      shouldShowMarkdownAnnotationsRef: { current: false },
      setCommentPopover: vi.fn(),
      setSelectionAnnotationTarget: vi.fn()
    },
    gutterMenu: {
      setGutterMenuOpen: vi.fn(),
      setGutterMenuPoint: vi.fn(),
      setGutterMenuLine: vi.fn()
    }
  }
}

function mount(worktreeId: string | undefined) {
  let disposeEditor: (() => void) | undefined
  const mockEditor = {
    getModel: () => null,
    onMouseDown: () => ({ dispose: vi.fn() }),
    onDidDispose: (listener: () => void) => {
      disposeEditor = listener
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every integration that reads the editor beyond the methods above is mocked.
  const editorInstance = mockEditor as unknown as editor.IStandaloneCodeEditor
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked integrations never read Monaco; it is only forwarded by identity.
  const monaco = {} as Parameters<OnMount>[1]
  const view = renderHook(() => useMonacoEditorMount(mountParams(worktreeId)))
  view.result.current(editorInstance, monaco)
  return { editorInstance, monaco, disposeEditor: () => disposeEditor?.() }
}

it('connects the debug gutter on mount and disposes it with the editor', () => {
  const { editorInstance, monaco, disposeEditor } = mount('repo-1::/repo')

  expect(connectDebugEditor).toHaveBeenCalledOnce()
  expect(connectDebugEditor).toHaveBeenCalledWith(editorInstance, monaco, {
    filePath: '/repo/app.py',
    worktreeId: 'repo-1::/repo'
  })
  expect(debugDispose).not.toHaveBeenCalled()

  disposeEditor()
  expect(debugDispose).toHaveBeenCalledOnce()
})

it('does not connect the debug gutter for a file outside any worktree', () => {
  const { disposeEditor } = mount(undefined)

  expect(connectDebugEditor).not.toHaveBeenCalled()
  disposeEditor()
  expect(debugDispose).not.toHaveBeenCalled()
})
