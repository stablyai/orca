// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import type { OnMount } from '@monaco-editor/react'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { ORCA_EDITOR_FILE_CACHE_STALE_EVENT } from './editor-autosave'
import type { MonacoEditorMountParams } from './monaco-editor-mount-params'
import { useMonacoEditorMount } from './use-monaco-editor-mount'

const filePath = '/repo/file.ts'
const disk = vi.hoisted(() => ({ text: 'B' }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      pendingEditorReveal: null,
      pendingEditorFocusRequest: null,
      editorDrafts: {},
      // A sibling wrote 'B' and this tab's baseline moved with it, but its panel cache kept 'A'.
      openFiles: [
        {
          id: 'tab-b',
          filePath: '/repo/file.ts',
          mode: 'edit',
          lastKnownDiskSignature: getDiskBaselineSignature(disk.text)
        }
      ]
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

afterEach(() => {
  cleanup()
  disk.text = 'B'
})

function setupMount() {
  const params: MonacoEditorMountParams = {
    fileId: 'tab-b',
    filePath,
    viewStateKey: 'tab-b-view',
    viewStateId: 'tab-b',
    worktreeId: 'wt-2',
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
    setEditorCursorLine: vi.fn(),
    setupCopy: vi.fn(),
    queueReveal: vi.fn(),
    contentSync: {
      contentRef: { current: 'A (stale cache)' },
      lastSyncedContentRef: { current: 'A (stale cache)' },
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
  const modelText = { value: 'B' }
  const model = {
    getValue: () => modelText.value,
    getEOL: () => '\n',
    pushEditOperations: vi.fn(),
    getFullModelRange: vi.fn()
  }
  const updateOptions = vi.fn()
  const executeEdits = vi.fn()
  const mockEditor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    focus: vi.fn(),
    updateOptions,
    executeEdits,
    pushUndoStop: vi.fn(),
    onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
    onDidScrollChange: () => ({ dispose: vi.fn() }),
    onMouseDown: () => ({ dispose: vi.fn() }),
    onDidDispose: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mount uses only the editor methods mocked above; decorations/input/probe integrations are mocked.
  const editorInstance = mockEditor as unknown as editor.IStandaloneCodeEditor
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked mount integrations do not access Monaco.
  const monaco = {} as Parameters<OnMount>[1]
  return { params, modelText, model, updateOptions, executeEdits, editorInstance, monaco }
}

it('mounts the live model over a stale retained cache, editable, and reloads a model-less stale cache once', () => {
  const { params, modelText, model, updateOptions, executeEdits, editorInstance, monaco } =
    setupMount()
  const dropped: string[] = []
  const onStale = (event: Event): void => {
    if (event instanceof CustomEvent) {
      dropped.push(event.detail.fileId)
    }
  }
  window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
  try {
    const view = renderHook(() => useMonacoEditorMount(params))
    view.result.current(editorInstance, monaco)

    expect(modelText.value).toBe('B')
    expect(model.pushEditOperations).not.toHaveBeenCalled()
    expect(executeEdits).not.toHaveBeenCalled()
    expect(updateOptions).not.toHaveBeenCalledWith({ readOnly: true })
    expect(dropped).toEqual([])

    // Without a fresh live model, evict the cache once without entering a remount/reload loop.
    modelText.value = 'A (stale cache)'
    for (let mount = 0; mount < 3; mount += 1) {
      view.result.current(editorInstance, monaco)
    }
    expect(dropped).toEqual(['tab-b'])
    expect(updateOptions).not.toHaveBeenCalledWith({ readOnly: true })
  } finally {
    window.removeEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
  }
})

it('reloads the same stale text again once the baseline moves or a fresh mount settles the reload', () => {
  const { params, modelText, editorInstance, monaco } = setupMount()
  const dropped: string[] = []
  const onStale = (event: Event): void => {
    if (event instanceof CustomEvent) {
      dropped.push(event.detail.fileId)
    }
  }
  window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
  const view = renderHook(() => useMonacoEditorMount(params))
  const mountWith = (text: string): void => {
    params.contentSync.contentRef.current = text
    modelText.value = text
    view.result.current(editorInstance, monaco)
  }
  try {
    mountWith('A2 (stale cache)')
    mountWith('A2 (stale cache)')
    expect(dropped).toHaveLength(1)

    // Another write moved the baseline: the same stale text must reload again.
    disk.text = 'C'
    mountWith('A2 (stale cache)')
    expect(dropped).toHaveLength(2)

    // The reload landed fresh text; stale text returning later reloads again.
    mountWith('C')
    expect(dropped).toHaveLength(2)
    mountWith('A2 (stale cache)')
    expect(dropped).toHaveLength(3)
  } finally {
    window.removeEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
  }
})
