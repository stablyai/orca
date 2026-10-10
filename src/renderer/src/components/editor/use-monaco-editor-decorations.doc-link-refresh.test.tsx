// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMonacoEditorDecorations } from './use-monaco-editor-decorations'
import type { MarkdownDocLinkDecorationController } from './monaco-markdown-doc-link-decorations'

vi.mock('./monaco-markdown-doc-completions', () => ({
  clearMarkdownDocCompletionDocuments: () => {},
  setMarkdownDocCompletionDocuments: () => {}
}))

const refresh = vi.fn()
const controller: MarkdownDocLinkDecorationController = { refresh, dispose: () => {} }

function Harness({ content, language }: { content: string; language: string }): null {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const decorations = useMonacoEditorDecorations({
    editorRef,
    mountedEditor: null,
    content,
    language,
    markdownDocuments: undefined,
    conflictDecorationsEnabled: false
  })
  decorations.markdownDocLinkDecorationsRef.current = controller
  return null
}

let container: HTMLDivElement
let root: Root

describe('useMonacoEditorDecorations doc-link refresh', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    refresh.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
  })

  it('does not refresh doc-link decorations on content changes', async () => {
    await act(async () => root.render(<Harness content="# a" language="markdown" />))
    refresh.mockClear()

    for (let keystroke = 0; keystroke < 200; keystroke += 1) {
      await act(async () =>
        root.render(<Harness content={`# a${'x'.repeat(keystroke)}`} language="markdown" />)
      )
    }

    // Why: `createMarkdownDocLinkDecorationController` already subscribes to
    // `onDidChangeModelContent`, so the React mirror was pure duplicate work.
    expect(refresh).not.toHaveBeenCalled()
  })

  it('still refreshes when the language of a retained model changes', async () => {
    await act(async () => root.render(<Harness content="# a" language="markdown" />))
    refresh.mockClear()

    await act(async () => root.render(<Harness content="# a" language="plaintext" />))

    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
