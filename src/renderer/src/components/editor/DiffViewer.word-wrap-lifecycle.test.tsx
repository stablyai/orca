// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DiffViewer from './DiffViewer'
import { DiffNavigationProvider, useDiffNavigation } from './diff-navigation-context'
import { getLargeDiffRenderLimitFromCounts } from './large-diff-render-limit'

const fixture = vi.hoisted(() => {
  function createEditor() {
    const disposals = new Set<() => void>()
    const modifiedEditor = {
      onDidDispose: (callback: () => void) => {
        disposals.add(callback)
        return { dispose: () => disposals.delete(callback) }
      }
    }
    const disposeUpdate = vi.fn()
    const editor = {
      getOriginalEditor: () => ({}),
      getModifiedEditor: () => modifiedEditor,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      onDidUpdateDiff: () => ({ dispose: disposeUpdate }),
      getLineChanges: () => [{}],
      goToDiff: vi.fn(),
      saveViewState: () => null,
      focus: vi.fn()
    }
    return { editor, disposeUpdate, dispose: () => disposals.forEach((callback) => callback()) }
  }
  const editors: ReturnType<typeof createEditor>[] = []
  const state = {
    settings: { diffWordWrap: true },
    editorFontZoomLevel: 0,
    addDiffComment: vi.fn(),
    deleteDiffComment: vi.fn(),
    updateDiffComment: vi.fn(),
    scrollToDiffCommentId: null,
    setScrollToDiffCommentId: vi.fn()
  }
  return { createEditor, editors, state }
})

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    onMount
  }: {
    onMount: (editor: ReturnType<typeof fixture.createEditor>['editor']) => void
  }) => {
    const mount = useRef(onMount)
    useEffect(() => {
      const instance = fixture.createEditor()
      fixture.editors.push(instance)
      let disposed = false
      queueMicrotask(() => {
        if (!disposed) {
          mount.current(instance.editor)
        }
      })
      return () => {
        disposed = true
        instance.dispose()
      }
    }, [])
    return <div />
  }
}))
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: typeof fixture.state) => T) => selector(fixture.state)
}))
vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffComments: () => undefined
}))
vi.mock('@/lib/monaco-setup', () => ({
  monaco: { Uri: { parse: (path: string) => path }, editor: { getModel: () => null } }
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({ useDiffCommentDecorator: vi.fn() }))
vi.mock('./useDiffViewerFirstChangeAutoScroll', () => ({
  useDiffViewerFirstChangeAutoScroll: vi.fn()
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('./diff-editor-line-number-options', () => ({
  applyDiffEditorLineNumberOptions: () => ({ dispose: vi.fn() })
}))
vi.mock('./diff-editor-word-wrap-options', () => ({
  buildDiffEditorWordWrapOptions: () => ({}),
  syncDiffEditorOriginalWordWrap: () => ({ dispose: vi.fn() })
}))
vi.mock('./diff-model-swap-view-state', () => ({
  preserveDiffViewStateAcrossModelSwaps: () => ({ dispose: vi.fn() })
}))
vi.mock('./editor-shortcuts', () => ({
  installMonacoDiffChangeNavigationShortcut: () => vi.fn(),
  installMonacoEditorCommandPaletteShortcut: () => vi.fn()
}))
vi.mock('./LargeDiffFallback', () => ({ LargeDiffFallback: () => <div>Large diff</div> }))

function NavigationProbe(): React.JSX.Element {
  const navigation = useDiffNavigation()
  return (
    <button disabled={navigation.changeCount === 0} onClick={navigation.goToNextDiff}>
      Next change ({navigation.changeCount})
    </button>
  )
}

function Surface({ limited }: { limited: boolean }): React.JSX.Element {
  return (
    <DiffNavigationProvider>
      <NavigationProbe />
      <DiffViewer
        modelKey="wrap-lifecycle"
        originalContent="original"
        modifiedContent="modified"
        language="markdown"
        filePath="README.md"
        relativePath="README.md"
        sideBySide
        largeDiffRenderLimit={getLargeDiffRenderLimitFromCounts({
          originalLineCount: limited ? 120_001 : 1,
          modifiedLineCount: 1,
          originalCharacterCount: 8,
          modifiedCharacterCount: 8
        })}
      />
    </DiffNavigationProvider>
  )
}

afterEach(() => {
  cleanup()
  fixture.editors.length = 0
})

describe('file diff word-wrap lifecycle', () => {
  it('unregisters navigation when inner disposal precedes the large-diff fallback effect', async () => {
    const view = render(<Surface limited={false} />)
    await act(async () => {
      await Promise.resolve()
    })
    const mounted = fixture.editors[0]
    const next = view.getByRole('button', { name: 'Next change (1)' })
    expect(next.hasAttribute('disabled')).toBe(false)
    act(() => next.click())
    expect(mounted?.editor.goToDiff).toHaveBeenCalledWith('next')

    view.rerender(<Surface limited />)

    expect(view.getByRole('button', { name: 'Next change (0)' }).hasAttribute('disabled')).toBe(
      true
    )
    expect(mounted?.disposeUpdate).toHaveBeenCalledOnce()
  })
})
