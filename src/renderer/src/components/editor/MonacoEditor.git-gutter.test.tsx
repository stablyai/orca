// @vitest-environment happy-dom
// Why: the only MonacoEditor.* test that drives `onMount` — the siblings assert on props before
// mount — so the fake editor and helper mocks below stub the whole mount path, most of it
// unrelated to the gutter. A `TypeError: fakeEditor.xyz is not a function` therefore means
// handleMount gained a call that needs a stub here, not that the gutter regressed.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
const gitGutterHook = vi.hoisted(() => vi.fn())

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/store', () => {
  const state = {
    settings: { theme: 'dark', terminalFontSize: 13, terminalFontFamily: 'monospace' },
    editorFontZoomLevel: 0,
    pendingEditorReveal: null,
    pendingEditorFocusRequest: null,
    setPendingEditorReveal: vi.fn(),
    setEditorCursorLine: vi.fn(),
    addDiffComment: vi.fn(),
    deleteDiffComment: vi.fn(),
    updateDiffComment: vi.fn(),
    scrollToDiffCommentId: null,
    setScrollToDiffCommentId: vi.fn(),
    worktreeDiffComments: {}
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = (): typeof state => state
  return { useAppStore }
})
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))
vi.mock('./git-gutter/useEditorGitGutter', () => ({ useEditorGitGutter: gitGutterHook }))
vi.mock('./monaco-e2e-probe', () => ({ installMonacoE2EProbe: () => () => {} }))
vi.mock('./monaco-markdown-doc-completions', () => ({
  clearMarkdownDocCompletionDocuments: vi.fn(),
  ensureMarkdownDocCompletionProvider: vi.fn(),
  setMarkdownDocCompletionDocuments: vi.fn()
}))
vi.mock('./monaco-markdown-doc-link-decorations', () => ({
  createMarkdownDocLinkDecorationController: () => ({ refresh: vi.fn(), dispose: vi.fn() })
}))

import MonacoEditor from './MonacoEditor'

const FILE_CONTENT = 'const a = 1\n'
const disposable = { dispose: vi.fn() }

function createFakeEditor(): editor.IStandaloneCodeEditor {
  const domNode = document.createElement('div')
  return {
    getContainerDomNode: () => domNode,
    getDomNode: () => domNode,
    getModel: () => null,
    getSelection: () => null,
    getPosition: () => null,
    getValue: () => '',
    getScrollTop: () => 0,
    getScrollHeight: () => 0,
    getContentHeight: () => 0,
    getVisibleRanges: () => [],
    saveViewState: () => null,
    restoreViewState: vi.fn(),
    setScrollTop: vi.fn(),
    setPosition: vi.fn(),
    layout: vi.fn(),
    updateOptions: vi.fn(),
    focus: vi.fn(),
    getAction: () => null,
    hasTextFocus: () => false,
    addAction: () => disposable,
    createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
    onDidChangeCursorPosition: () => disposable,
    onDidChangeCursorSelection: () => disposable,
    onDidChangeModelContent: () => disposable,
    onDidContentSizeChange: () => disposable,
    onDidScrollChange: () => disposable,
    onDidLayoutChange: () => disposable,
    onMouseDown: () => disposable,
    onDidDispose: () => disposable
  } as unknown as editor.IStandaloneCodeEditor
}

type MountHandler = (editorInstance: editor.IStandaloneCodeEditor, monaco: unknown) => void

const fakeMonaco = { editor: { MouseTargetType: { GUTTER_LINE_NUMBERS: 3 } } }

afterEach(() => {
  cleanup()
  editorProps.current = null
  gitGutterHook.mockClear()
})

describe('MonacoEditor git gutter wiring', () => {
  it('drives the gutter hook with the mounted editor, file id and content', () => {
    render(
      <MonacoEditor
        fileId="tab-7"
        filePath="/repo/src/app.ts"
        viewStateKey="pane:tab-7"
        relativePath="src/app.ts"
        content={FILE_CONTENT}
        language="typescript"
        onContentChange={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(gitGutterHook).toHaveBeenCalledWith({
      editorInstance: null,
      fileId: 'tab-7',
      content: FILE_CONTENT
    })

    const fakeEditor = createFakeEditor()
    const onMount = editorProps.current?.onMount as MountHandler | undefined
    expect(onMount).toBeTypeOf('function')
    act(() => {
      onMount?.(fakeEditor, fakeMonaco)
    })

    expect(gitGutterHook).toHaveBeenLastCalledWith({
      editorInstance: fakeEditor,
      fileId: 'tab-7',
      content: FILE_CONTENT
    })
  })
})
