// @vitest-environment happy-dom
import { act, useRef, type MutableRefObject } from 'react'
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

let latestChangedLineDecorationsRef: MutableRefObject<editor.IEditorDecorationsCollection | null> | null =
  null

function Harness({
  content,
  mountedEditor = fakeEditor
}: {
  content: string
  mountedEditor?: editor.IStandaloneCodeEditor
}): null {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const decorations = useMonacoEditorDecorations({
    editorRef,
    mountedEditor,
    content,
    language: 'typescript',
    markdownDocuments: undefined,
    conflictDecorationsEnabled: false,
    changedLineDecorationsEnabled: true,
    diffContent
  })
  latestChangedLineDecorationsRef = decorations.changedLineDecorationsRef
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

  it('creates a fresh collection for a new editor instead of reusing the previous one', async () => {
    const secondCreateDecorationsCollection = vi.fn()
    const setDecorationsOnSecondEditor = vi.fn()
    const secondEditor = {
      createDecorationsCollection: (initial: unknown) => {
        secondCreateDecorationsCollection(initial)
        return { set: setDecorationsOnSecondEditor, clear: vi.fn() }
      }
    } as unknown as editor.IStandaloneCodeEditor

    await act(async () =>
      root.render(<Harness content="one\ntwo\nthree" mountedEditor={fakeEditor} />)
    )
    vi.advanceTimersByTime(CHANGED_LINE_DECORATION_DEBOUNCE_MS)
    expect(createDecorationsCollection).toHaveBeenCalledTimes(1)

    // Why: the real editor-mount lifecycle clears this ref when the old editor
    // is disposed, before the new one mounts — reproduce that here since this
    // harness doesn't run that lifecycle itself.
    latestChangedLineDecorationsRef!.current = null

    await act(async () =>
      root.render(<Harness content="one\nTWO\nthree" mountedEditor={secondEditor} />)
    )
    vi.advanceTimersByTime(CHANGED_LINE_DECORATION_DEBOUNCE_MS)

    expect(secondCreateDecorationsCollection).toHaveBeenCalledTimes(1)
    expect(setDecorationsOnSecondEditor).not.toHaveBeenCalled()
  })
})
