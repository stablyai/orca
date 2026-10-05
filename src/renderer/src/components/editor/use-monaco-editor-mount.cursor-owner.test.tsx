// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import type { OnMount } from '@monaco-editor/react'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { MonacoEditorMountParams } from './monaco-editor-mount-params'
import { useMonacoEditorMount } from './use-monaco-editor-mount'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ pendingEditorReveal: null, pendingEditorFocusRequest: null }) }
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

afterEach(cleanup)

it('keeps a retained cursor listener on the current file ID after same-path owner migration', () => {
  const store = createEditorTabsStore()
  const filePath = '/repo/file.ts'
  const oldId = 'restored-file'
  store.setState({
    activeFileId: null,
    openFiles: [
      {
        id: oldId,
        filePath,
        relativePath: 'file.ts',
        worktreeId: 'old-workspace',
        language: 'typescript',
        mode: 'edit',
        isDirty: false
      }
    ],
    runtimeEnvironments: [],
    detectedWorktreesByRepo: {}
  })
  const params: MonacoEditorMountParams = {
    fileId: oldId,
    filePath,
    viewStateKey: 'stable-tab-view',
    viewStateId: 'stable-tab',
    worktreeId: 'old-workspace',
    autoHeight: false,
    autoHeightLineHeight: 20,
    editorRef: { current: null },
    editorContainerRef: { current: null },
    languageRef: { current: 'typescript' },
    propsRef: {
      current: {
        relativePath: 'file.ts',
        language: 'typescript',
        onSave: vi.fn(),
        onContentChange: vi.fn()
      }
    },
    readOnlyRef: { current: false },
    scrollThrottleTimerRef: { current: null },
    unregisterFileSearchSelectionRef: { current: null },
    setMountedEditor: vi.fn(),
    setAutoHeightContentHeight: vi.fn(),
    setEditorCursorLine: store.getState().setEditorCursorLine,
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
  let emitCursor:
    | ((event: { position: { lineNumber: number; column: number } }) => void)
    | undefined
  let disposeEditor: (() => void) | undefined
  const cursorDispose = vi.fn()
  const mockEditor = {
    getModel: () => null,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    focus: vi.fn(),
    onDidChangeCursorPosition: (listener: NonNullable<typeof emitCursor>) => {
      emitCursor = listener
      return { dispose: cursorDispose }
    },
    onDidScrollChange: () => ({ dispose: vi.fn() }),
    onMouseDown: () => ({ dispose: vi.fn() }),
    onDidDispose: (listener: () => void) => {
      disposeEditor = listener
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mount and tracking use only the editor methods mocked above; decorations/input/probe integrations are mocked.
  const editorInstance = mockEditor as unknown as editor.IStandaloneCodeEditor
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked mount integrations do not access Monaco, and the mouse listener is not invoked.
  const monaco = {} as Parameters<OnMount>[1]
  const suspendedRender = vi.fn()
  const neverCommits = new Promise<void>(() => {})
  const view = renderHook(
    ({ next, suspend }: { next: MonacoEditorMountParams; suspend: boolean }) => {
      const onMount = useMonacoEditorMount(next)
      if (suspend) {
        suspendedRender()
        throw neverCommits
      }
      return onMount
    },
    {
      initialProps: { next: params, suspend: false },
      wrapper: ({ children }) => <Suspense fallback={null}>{children}</Suspense>
    }
  )
  view.result.current(editorInstance, monaco)
  expect(store.getState().editorCursorLine).toEqual({ [oldId]: 1 })

  view.rerender({ next: { ...params, fileId: 'uncommitted-owner' }, suspend: true })
  expect(suspendedRender).toHaveBeenCalled()
  emitCursor?.({ position: { lineNumber: 7, column: 1 } })
  expect(store.getState().editorCursorLine).toEqual({ [oldId]: 7 })

  const result = store.getState().reparentRestoredEditorFileOwner({
    fileId: oldId,
    targetWorktreeId: 'wt-1',
    targetRelativePath: 'file.ts',
    targetExecutionHostId: 'local',
    targetRuntimeEnvironmentId: null,
    targetOperationProvenance: captureEditorFileOperationProvenance(
      store.getState(),
      'wt-1',
      null,
      true
    )
  })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(`Owner migration failed: ${result.reason}`)
  }
  expect(store.getState().openFiles[0].filePath).toBe(filePath)
  view.rerender({
    next: { ...params, fileId: result.fileId, worktreeId: 'wt-1' },
    suspend: false
  })
  emitCursor?.({ position: { lineNumber: 42, column: 1 } })

  expect(store.getState().editorCursorLine).toEqual({ [result.fileId]: 42 })
  disposeEditor?.()
  expect(cursorDispose).toHaveBeenCalledOnce()
  params.unregisterFileSearchSelectionRef.current?.()
  view.unmount()
  store.getState().closeFile(result.fileId)
  expect(store.getState().editorCursorLine).toEqual({})
})
