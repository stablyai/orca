// @vitest-environment happy-dom
// Why: `editable` is dynamic on the live diff pane (a failed load recovering under it), so DiffViewer must
// re-wire save/find/change in place. Remounting to re-run the mount wiring would also re-run its focus grab.
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffViewerProps } from './diff-viewer-props'

type Disposable = { dispose: ReturnType<typeof vi.fn> }
type CodeEditorStub = {
  getContainerDomNode: () => HTMLElement
  focus: ReturnType<typeof vi.fn>
  onDidChangeModelContent: ReturnType<typeof vi.fn>
}
type DiffEditorStub = { focus: ReturnType<typeof vi.fn> }

const shortcuts = vi.hoisted(() => ({
  saveInstalls: [] as { target: HTMLElement; cleanup: ReturnType<typeof vi.fn> }[],
  findInstalls: [] as { editor: unknown; cleanup: ReturnType<typeof vi.fn> }[]
}))
const monacoMount = vi.hoisted(() => ({
  count: 0,
  // Why: assigned before the first render; the mock reads it lazily so the stubs can be rebuilt per test.
  getDiffEditor: null as (() => unknown) | null
}))

vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react')
  return {
    DiffEditor: (props: { onMount: (diffEditor: unknown, monaco: unknown) => void }) => {
      const { onMount } = props
      useEffect(() => {
        monacoMount.count += 1
        onMount(monacoMount.getDiffEditor?.(), {})
        // Why: mirror @monaco-editor/react, which pins onMount to the first render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return null
    },
    loader: { config: vi.fn() }
  }
})
vi.mock('@/lib/monaco-setup', () => ({
  monaco: { editor: { EditorOption: { lineHeight: 66 } } }
}))
vi.mock('./editor-shortcuts', () => ({
  installEditorSaveShortcut: (target: HTMLElement) => {
    const cleanup = vi.fn()
    shortcuts.saveInstalls.push({ target, cleanup })
    return cleanup
  },
  installMonacoEditorFindShortcut: (targetEditor: unknown) => {
    const cleanup = vi.fn()
    shortcuts.findInstalls.push({ editor: targetEditor, cleanup })
    return cleanup
  },
  installMonacoDiffChangeNavigationShortcut: () => (): void => {}
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { theme: 'dark', terminalFontSize: 13 },
      editorFontZoomLevel: 0,
      addDiffComment: vi.fn(),
      deleteDiffComment: vi.fn(),
      updateDiffComment: vi.fn(),
      scrollToDiffCommentId: null,
      setScrollToDiffCommentId: vi.fn(),
      worktreeDiffComments: {}
    })
}))

import DiffViewer from './DiffViewer'

let contentSubs: Disposable[] = []
let originalEditor: CodeEditorStub
let modifiedEditor: CodeEditorStub
let diffEditor: DiffEditorStub

function makeDisposable(): Disposable {
  return { dispose: vi.fn() }
}

function makeCodeEditorStub(pane: string): CodeEditorStub {
  const container = document.createElement('div')
  container.dataset.pane = pane
  return {
    getContainerDomNode: () => container,
    focus: vi.fn(),
    onDidChangeModelContent: vi.fn(() => {
      const sub = makeDisposable()
      contentSubs.push(sub)
      return sub
    }),
    getValue: () => 'body',
    getModel: () => ({}),
    getRawOptions: () => ({ lineNumbers: 'on' }),
    getOption: () => 18,
    updateOptions: vi.fn(),
    onDidChangeConfiguration: makeDisposable,
    onWillChangeModel: makeDisposable,
    onDidChangeModel: makeDisposable,
    onDidScrollChange: makeDisposable,
    onDidContentSizeChange: makeDisposable,
    onDidLayoutChange: makeDisposable,
    onDidDispose: vi.fn()
  } as unknown as CodeEditorStub
}

function makeDiffEditorStub(): DiffEditorStub {
  return {
    getOriginalEditor: () => originalEditor,
    getModifiedEditor: () => modifiedEditor,
    getLineChanges: () => [],
    getModel: () => null,
    saveViewState: () => null,
    restoreViewState: vi.fn(),
    focus: vi.fn(),
    onDidUpdateDiff: makeDisposable,
    onDidDispose: vi.fn()
  } as unknown as DiffEditorStub
}

function viewer(editable: boolean): React.JSX.Element {
  const props: DiffViewerProps = {
    modelKey: 'tab-1',
    originalContent: 'a\n',
    modifiedContent: 'b\n',
    language: 'typescript',
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    sideBySide: true,
    editable,
    onSave: vi.fn(),
    onContentChange: vi.fn()
  }
  return <DiffViewer {...props} />
}

beforeEach(() => {
  shortcuts.saveInstalls.length = 0
  shortcuts.findInstalls.length = 0
  contentSubs = []
  monacoMount.count = 0
  originalEditor = makeCodeEditorStub('original')
  modifiedEditor = makeCodeEditorStub('modified')
  diffEditor = makeDiffEditorStub()
  monacoMount.getDiffEditor = () => diffEditor
})

afterEach(cleanup)

describe('DiffViewer editable re-wiring', () => {
  it('installs the editing wiring exactly once when it mounts already editable', () => {
    render(viewer(true))

    expect(shortcuts.saveInstalls).toHaveLength(1)
    expect(shortcuts.findInstalls).toHaveLength(2)
    expect(contentSubs).toHaveLength(1)
  })

  it('wires the same editor when editable flips on, without remounting or refocusing', () => {
    const { rerender } = render(viewer(false))
    expect(shortcuts.saveInstalls).toHaveLength(0)
    expect(contentSubs).toHaveLength(0)
    expect(diffEditor.focus).toHaveBeenCalledTimes(1)

    rerender(viewer(true))

    expect(monacoMount.count).toBe(1)
    expect(shortcuts.saveInstalls).toHaveLength(1)
    expect(shortcuts.saveInstalls[0]?.target).toBe(modifiedEditor.getContainerDomNode())
    expect(shortcuts.findInstalls.map((i) => i.editor)).toEqual([originalEditor, modifiedEditor])
    expect(modifiedEditor.onDidChangeModelContent).toHaveBeenCalledTimes(1)
    // Why: the flip is unattended (a background refetch), so it must not pull focus out from under typing.
    expect(modifiedEditor.focus).not.toHaveBeenCalled()
    expect(diffEditor.focus).toHaveBeenCalledTimes(1)
  })

  it('tears the wiring down again when editable flips off', () => {
    const { rerender } = render(viewer(true))

    rerender(viewer(false))

    expect(shortcuts.saveInstalls[0]?.cleanup).toHaveBeenCalledTimes(1)
    expect(shortcuts.findInstalls.map((i) => i.cleanup.mock.calls.length)).toEqual([1, 1])
    expect(contentSubs[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes the wiring on unmount', () => {
    const { unmount } = render(viewer(true))

    unmount()

    expect(shortcuts.saveInstalls[0]?.cleanup).toHaveBeenCalledTimes(1)
    expect(contentSubs[0]?.dispose).toHaveBeenCalledTimes(1)
  })
})
