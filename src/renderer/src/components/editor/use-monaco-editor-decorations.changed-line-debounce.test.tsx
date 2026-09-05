// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import {
  CHANGED_LINE_DECORATION_DEBOUNCE_MS,
  useMonacoEditorDecorations
} from './use-monaco-editor-decorations'

vi.mock('./monaco-markdown-doc-completions', () => ({
  clearMarkdownDocCompletionDocuments: () => {},
  setMarkdownDocCompletionDocuments: () => {}
}))

const createDecorationsCollection = vi.fn()
const setDecorations = vi.fn()
const clearDecorations = vi.fn()

const fakeEditor = {
  createDecorationsCollection: (initial: unknown) => {
    createDecorationsCollection(initial)
    return { set: setDecorations, clear: clearDecorations }
  }
} as unknown as editor.IStandaloneCodeEditor

const diffContent: GitDiffResult = {
  kind: 'text',
  originalContent: 'one\ntwo\nthree',
  modifiedContent: 'one\ntwo\nthree',
  originalIsBinary: false,
  modifiedIsBinary: false
}

function Harness({ content }: { content: string }): null {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  useMonacoEditorDecorations({
    editorRef,
    mountedEditor: fakeEditor,
    content,
    language: 'typescript',
    markdownDocuments: undefined,
    conflictDecorationsEnabled: false,
    changedLineDecorationsEnabled: true,
    diffContent
  })
  return null
}

let container: HTMLDivElement
let root: Root

describe('useMonacoEditorDecorations changed-line debounce', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    createDecorationsCollection.mockClear()
    setDecorations.mockClear()
    clearDecorations.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => root.unmount())
    document.body.replaceChildren()
  })

  it('coalesces rapid content changes into a single recompute', async () => {
    await act(async () => root.render(<Harness content="one\ntwo\nthree" />))
    vi.advanceTimersByTime(CHANGED_LINE_DECORATION_DEBOUNCE_MS)
    expect(createDecorationsCollection).toHaveBeenCalledTimes(1)
    setDecorations.mockClear()

    for (let keystroke = 0; keystroke < 50; keystroke += 1) {
      await act(async () =>
        root.render(<Harness content={`one\ntwo${'x'.repeat(keystroke)}\nthree`} />)
      )
    }

    // Why: each render restarts the debounce timer, so no recompute should
    // fire while renders keep arriving faster than the debounce window.
    expect(setDecorations).not.toHaveBeenCalled()

    vi.advanceTimersByTime(CHANGED_LINE_DECORATION_DEBOUNCE_MS)

    expect(setDecorations).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending recompute when unmounted before the debounce fires', async () => {
    const localContainer = document.body.appendChild(document.createElement('div'))
    const localRoot = createRoot(localContainer)

    await act(async () => localRoot.render(<Harness content="one\ntwo\nthree" />))
    vi.advanceTimersByTime(CHANGED_LINE_DECORATION_DEBOUNCE_MS)
    setDecorations.mockClear()

    await act(async () => localRoot.render(<Harness content="one\nTWO\nthree" />))
    await act(async () => localRoot.unmount())
    localContainer.remove()

    vi.advanceTimersByTime(CHANGED_LINE_DECORATION_DEBOUNCE_MS)

    expect(setDecorations).not.toHaveBeenCalled()
  })
})
