// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { editor, IRange } from 'monaco-editor'
import type { OnMount } from '@monaco-editor/react'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { MonacoEditorMountParams } from './monaco-editor-mount-params'
import { useMonacoEditorMount } from './use-monaco-editor-mount'
import { MonacoGutterContextMenu } from './MonacoGutterContextMenu'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const storeRef = vi.hoisted((): { current?: StoreApi<AppState> } => ({}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeRef.current?.getState() }
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mountParams(
  store: StoreApi<AppState>,
  fileId: string,
  filePath: string
): MonacoEditorMountParams {
  return {
    fileId,
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
      setGutterMenuLine: vi.fn(),
      setGutterMenuSelection: vi.fn()
    }
  }
}

it('keeps cursor and gutter copy on the current file owner after migration', async () => {
  const store = createEditorTabsStore()
  storeRef.current = store
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
  const params = mountParams(store, oldId, filePath)
  let emitCursor:
    | ((event: { position: { lineNumber: number; column: number } }) => void)
    | undefined
  let disposeEditor: (() => void) | undefined
  const cursorDispose = vi.fn()
  let mouseDown: (event: unknown) => void = () => {}
  let selection: IRange = { startLineNumber: 10, startColumn: 1, endLineNumber: 21, endColumn: 1 }
  const mockEditor = {
    getSelection: () => selection,
    setPosition: () => {
      selection = { ...selection, startLineNumber: 15, endLineNumber: 15 }
    },
    getModel: () => null,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    focus: vi.fn(),
    onDidChangeCursorPosition: (listener: NonNullable<typeof emitCursor>) => {
      emitCursor = listener
      return { dispose: cursorDispose }
    },
    onDidScrollChange: () => ({ dispose: vi.fn() }),
    onMouseDown: (listener: typeof mouseDown) => {
      mouseDown = listener
      return { dispose: vi.fn() }
    },
    onDidDispose: (listener: () => void) => {
      disposeEditor = listener
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mount and tracking use only the editor methods mocked above; decorations/input/probe integrations are mocked.
  const editorInstance = mockEditor as unknown as editor.IStandaloneCodeEditor
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked mount integrations use only this gutter enum.
  const monaco = {
    editor: { MouseTargetType: { GUTTER_LINE_NUMBERS: 3 } }
  } as Parameters<OnMount>[1]
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
  vi.stubGlobal('api', { git: { remoteFileUrl: vi.fn() }, ui: { writeClipboardText: vi.fn() } })
  const snapshot = { ...selection }
  mouseDown({
    event: Object.assign(new MouseEvent('mousedown'), { rightButton: true }),
    target: { type: 3, position: { lineNumber: 15 } }
  })
  expect(params.gutterMenu.setGutterMenuSelection).toHaveBeenCalledWith(snapshot)
  expect(selection).not.toEqual(snapshot)
  const copiedUrl = 'https://github.com/org/repo/blob/main/file.ts#L10-L20'
  const local = vi.spyOn(window.api.git, 'remoteFileUrl').mockResolvedValue(copiedUrl)
  const clipboard = vi.spyOn(window.api.ui, 'writeClipboardText')
  for (const runtimeEnvironmentId of [null, 'paired']) {
    store.setState({ openFiles: [{ ...store.getState().openFiles[0], runtimeEnvironmentId }] })
    const transport = runtimeEnvironmentId ? vi.mocked(callRuntimeRpc) : local
    transport.mockResolvedValue(copiedUrl)
    for (const line of [15, 21]) {
      const menu = MonacoGutterContextMenu({
        open: true,
        onOpenChange: vi.fn(),
        point: { x: 0, y: 0 },
        line,
        selection: snapshot,
        filePath,
        relativePath: 'file.ts'
      })
      const action = menu.props.children[1].props.children[2].props.onSelect
      await action()
      const expected = {
        relativePath: 'file.ts',
        line: line === 15 ? 10 : line,
        endLine: line === 15 ? 20 : undefined
      }
      const owner = runtimeEnvironmentId
        ? [
            { kind: 'environment', environmentId: 'paired' },
            'git.remoteFileUrl',
            { worktree: 'id:wt-1', ...expected },
            { timeoutMs: 15_000 }
          ]
        : [{ worktreePath: '/repo', connectionId: undefined, ...expected }]
      expect(transport).toHaveBeenLastCalledWith(...owner)
      expect(clipboard).toHaveBeenLastCalledWith(copiedUrl)
      clipboard.mockClear()
      transport.mockResolvedValueOnce(null)
      await action()
      expect(clipboard).not.toHaveBeenCalled()
      transport.mockRejectedValueOnce(new Error('owner unavailable'))
      await expect(action()).rejects.toThrow('owner unavailable')
      expect(clipboard).not.toHaveBeenCalled()
    }
  }
  disposeEditor?.()
  expect(cursorDispose).toHaveBeenCalledOnce()
  params.unregisterFileSearchSelectionRef.current?.()
  view.unmount()
  store.getState().closeFile(result.fileId)
  expect(store.getState().editorCursorLine).toEqual({})
})

it("a passive mirror never moves the borrowed tab's cursor line or takes its reveal", () => {
  const store = createEditorTabsStore()
  storeRef.current = store
  const filePath = '/repo/file.ts'
  const reveal = { fileId: 'borrowed', filePath, line: 9, column: 1, matchLength: 0 }
  store.setState({ pendingEditorReveal: reveal, editorCursorLine: { borrowed: 3 } })
  const params = { ...mountParams(store, 'borrowed', filePath), passiveMirror: true }
  let emitCursor: ((event: { position: { lineNumber: number } }) => void) | undefined
  const mockEditor = {
    getModel: () => null,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    focus: vi.fn(),
    onDidChangeCursorPosition: (listener: NonNullable<typeof emitCursor>) => {
      emitCursor = listener
      return { dispose: vi.fn() }
    },
    onDidScrollChange: () => ({ dispose: vi.fn() }),
    onMouseDown: () => ({ dispose: vi.fn() }),
    onDidDispose: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mount and tracking use only the editor methods mocked above; decorations/input/probe integrations are mocked.
  const editorInstance = mockEditor as unknown as editor.IStandaloneCodeEditor
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked mount integrations do not access Monaco, and the mouse listener is not invoked.
  const monaco = {} as Parameters<OnMount>[1]
  const view = renderHook(() => useMonacoEditorMount(params))

  view.result.current(editorInstance, monaco)
  emitCursor?.({ position: { lineNumber: 7 } })

  expect(store.getState().editorCursorLine).toEqual({ borrowed: 3 })
  expect(params.queueReveal).not.toHaveBeenCalled()
  expect(store.getState().pendingEditorReveal).toBe(reveal)
  params.unregisterFileSearchSelectionRef.current?.()
})
