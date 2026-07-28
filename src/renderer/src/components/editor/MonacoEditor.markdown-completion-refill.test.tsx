// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/types'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
const storeState = vi.hoisted(() => ({
  settings: { theme: 'dark', terminalFontSize: 13, terminalFontFamily: 'monospace' },
  editorFontZoomLevel: 0,
  setPendingEditorReveal: vi.fn(),
  setEditorCursorLine: vi.fn(),
  addDiffComment: vi.fn(),
  deleteDiffComment: vi.fn(),
  updateDiffComment: vi.fn(),
  scrollToDiffCommentId: null,
  setScrollToDiffCommentId: vi.fn(),
  worktreeDiffComments: {},
  // This editor is scoped to a worktree, so the diff-comment selector indexes over this.
  worktreesByRepo: {}
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: Record<string, unknown>) => unknown): unknown =>
    selector(storeState)
  useAppStore.getState = () => storeState
  return { useAppStore }
})
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))

import MonacoEditor from './MonacoEditor'
import {
  MARKDOWN_COMPLETION_MAX_SCOPES,
  resetMarkdownCompletionRetentionForTests,
  setMarkdownDocCompletionDocuments
} from './monaco-markdown-doc-completions'

type CompletionProvider = {
  provideCompletionItems: (
    model: { uri: { toString: () => string }; getLineContent: (line: number) => string },
    position: { lineNumber: number; column: number }
  ) => { suggestions: { label: string }[] }
}

const MODEL_URI = 'file:///repo/notes.md'

function makeDocuments(scope: string): MarkdownDocument[] {
  return [
    {
      filePath: `/repo/${scope}.md`,
      relativePath: `${scope}.md`,
      basename: `${scope}.md`,
      name: scope
    }
  ]
}

type MountedEditor = {
  provider: CompletionProvider
  setDocuments: (documents: MarkdownDocument[]) => void
}

/** Minimal stand-in for the Monaco API surface the completion provider actually touches. */
function mountEditorWithMarkdownDocuments(documents: MarkdownDocument[]): MountedEditor {
  let registered: CompletionProvider | null = null
  const monaco = {
    languages: {
      CompletionItemKind: { File: 20 },
      registerCompletionItemProvider: (_language: string, provider: CompletionProvider) => {
        registered = provider
        return { dispose: vi.fn() }
      }
    }
  }
  const model = {
    uri: { toString: () => MODEL_URI },
    getValue: () => '# notes',
    getLineCount: () => 1,
    getEOL: () => '\n',
    getLineContent: () => '# notes',
    getFullModelRange: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 8
    }),
    onDidChangeContent: () => ({ dispose: vi.fn() }),
    pushEditOperations: vi.fn(),
    pushStackElement: vi.fn(),
    setValue: vi.fn()
  }
  const editorInstance = {
    getModel: () => model,
    onDidChangeModelContent: () => ({ dispose: vi.fn() }),
    onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
    onDidContentSizeChange: () => ({ dispose: vi.fn() }),
    onMouseDown: () => ({ dispose: vi.fn() }),
    onKeyDown: () => ({ dispose: vi.fn() }),
    onDidFocusEditorText: () => ({ dispose: vi.fn() }),
    onDidBlurEditorText: () => ({ dispose: vi.fn() }),
    onDidScrollChange: () => ({ dispose: vi.fn() }),
    onDidDispose: () => ({ dispose: vi.fn() }),
    onDidChangeModel: () => ({ dispose: vi.fn() }),
    onDidPaste: () => ({ dispose: vi.fn() }),
    onMouseUp: () => ({ dispose: vi.fn() }),
    onMouseMove: () => ({ dispose: vi.fn() }),
    onMouseLeave: () => ({ dispose: vi.fn() }),
    onContextMenu: () => ({ dispose: vi.fn() }),
    onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
    getContentHeight: () => 100,
    createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
    getDomNode: () => null,
    getContainerDomNode: () => document.createElement('div'),
    getScrollTop: () => 0,
    setScrollTop: vi.fn(),
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    setPosition: vi.fn(),
    saveViewState: () => null,
    restoreViewState: vi.fn(),
    focus: vi.fn(),
    layout: vi.fn(),
    revealLineInCenter: vi.fn(),
    addCommand: vi.fn(),
    addAction: () => ({ dispose: vi.fn() }),
    updateOptions: vi.fn(),
    getValue: () => '# notes',
    setValue: vi.fn(),
    executeEdits: vi.fn(),
    pushUndoStop: vi.fn()
  }

  const editorFor = (nextDocuments: MarkdownDocument[]): React.JSX.Element => (
    <MonacoEditor
      fileId="file"
      filePath="/repo/notes.md"
      viewStateKey="pane:file"
      relativePath="notes.md"
      content="# notes"
      language="markdown"
      worktreeId="worktree-under-test"
      markdownDocuments={nextDocuments}
      onContentChange={vi.fn()}
      onSave={vi.fn()}
      readOnly
    />
  )
  const { rerender } = render(editorFor(documents))

  const onMount = editorProps.current?.onMount as
    | ((editorInstance: unknown, monaco: unknown) => void)
    | undefined
  onMount?.(editorInstance, monaco)
  if (!registered) {
    throw new Error('MonacoEditor did not register a completion provider')
  }
  return {
    provider: registered,
    setDocuments: (nextDocuments) => rerender(editorFor(nextDocuments))
  }
}

function requestCompletions(provider: CompletionProvider): string[] {
  return provider
    .provideCompletionItems(
      { uri: { toString: () => MODEL_URI }, getLineContent: () => 'see [[' },
      { lineNumber: 1, column: 7 }
    )
    .suggestions.map((suggestion) => suggestion.label)
}

afterEach(() => {
  cleanup()
  editorProps.current = null
  resetMarkdownCompletionRetentionForTests()
})

function evictEverythingElse(): void {
  for (let index = 0; index <= MARKDOWN_COMPLETION_MAX_SCOPES; index += 1) {
    setMarkdownDocCompletionDocuments(
      `model-${index}`,
      `scope-${index}`,
      makeDocuments(`other-${index}`)
    )
  }
}

describe('MonacoEditor markdown completion refill', () => {
  it('offers completions for the mounted editor', () => {
    const { provider } = mountEditorWithMarkdownDocuments(makeDocuments('design'))

    expect(requestCompletions(provider)).toEqual(['design'])
  })

  // Why: the retention limits live two modules below this component. Asserting only on the
  // completion module leaves the wiring untested — deleting the refill registration in
  // MonacoEditor keeps those tests green while the user sees an editor with no completions.
  it('still offers completions after other editors evict this one', () => {
    const { provider } = mountEditorWithMarkdownDocuments(makeDocuments('design'))
    evictEverythingElse()

    expect(requestCompletions(provider)).toEqual(['design'])
  })

  // Why: the refill outlives the render that registered it. Capturing that render's closure
  // would re-supply the document list the editor had at mount, so a file added afterwards
  // would stay missing from completions for as long as the editor stays open.
  it('re-supplies the current documents, not the ones present when it mounted', () => {
    const { provider, setDocuments } = mountEditorWithMarkdownDocuments(makeDocuments('design'))
    setDocuments(makeDocuments('architecture'))
    evictEverythingElse()

    expect(requestCompletions(provider)).toEqual(['architecture'])
  })
})
