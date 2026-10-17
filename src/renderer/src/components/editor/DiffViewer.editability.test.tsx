// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { StrictMode, useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DiffViewer from './DiffViewer'

const fixture = vi.hoisted(() => {
  function codeEditor() {
    const dom = document.createElement('div')
    const changes = new Set<() => void>()
    const disposals = new Set<() => void>()
    return {
      dom,
      changes,
      disposals,
      focus: vi.fn(),
      getValue: () => 'modified file',
      getContainerDomNode: () => dom,
      onDidChangeModelContent: (callback: () => void) => {
        changes.add(callback)
        return { dispose: () => changes.delete(callback) }
      },
      onDidDispose: (callback: () => void) => {
        disposals.add(callback)
        return { dispose: () => disposals.delete(callback) }
      }
    }
  }
  function createEditor() {
    const original = codeEditor()
    const modified = codeEditor()
    return {
      original,
      modified,
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      onDidDispose: () => ({ dispose: () => {} }),
      saveViewState: () => null,
      focus: vi.fn()
    }
  }
  const result: {
    createEditor: typeof createEditor
    instance: ReturnType<typeof createEditor> | null
    mounts: number
    saves: Map<HTMLElement, () => void>
    finds: Set<object>
    state: { settings: null; editorFontZoomLevel: number }
  } = {
    createEditor,
    instance: null,
    mounts: 0,
    saves: new Map<HTMLElement, () => void>(),
    finds: new Set<object>(),
    state: { settings: null, editorFontZoomLevel: 0 }
  }
  return result
})

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    onMount
  }: {
    onMount: (editor: ReturnType<typeof fixture.createEditor>) => void
  }) => {
    const mount = useRef(onMount)
    useEffect(() => {
      const instance = fixture.createEditor()
      fixture.instance = instance
      fixture.mounts++
      mount.current(instance)
      return () => instance.modified.disposals.forEach((dispose) => dispose())
    }, [])
    return <div>Mounted diff editor</div>
  }
}))
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: typeof fixture.state) => T) => selector(fixture.state)
}))
vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffComments: () => undefined
}))
vi.mock('./useDiffViewerLargeDiffLifecycle', () => ({
  useDiffViewerLargeDiffLifecycle: () => ({
    originalModelPath: 'original',
    modifiedModelPath: 'modified'
  })
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: () => {}, toastNode: null })
}))
vi.mock('./diff-navigation-context', () => ({
  useDiffEditorRegistration: () => ({
    registerDiffEditor: () => {},
    unregisterDiffEditor: () => {}
  })
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({ useDiffCommentDecorator: () => {} }))
vi.mock('./useDiffViewerFirstChangeAutoScroll', () => ({
  useDiffViewerFirstChangeAutoScroll: () => {}
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('./diff-editor-line-number-options', () => ({
  applyDiffEditorLineNumberOptions: () => ({ dispose: () => {} })
}))
vi.mock('./diff-editor-word-wrap-options', () => ({
  buildDiffEditorWordWrapOptions: () => ({}),
  syncDiffEditorOriginalWordWrap: () => ({ dispose: () => {} })
}))
vi.mock('./diff-model-swap-view-state', () => ({
  preserveDiffViewStateAcrossModelSwaps: () => ({ dispose: () => {} })
}))
vi.mock('./editor-shortcuts', () => ({
  installEditorSaveShortcut: (dom: HTMLElement, save: () => void) => {
    fixture.saves.set(dom, save)
    return () => fixture.saves.delete(dom)
  },
  installMonacoEditorFindShortcut: (
    editor: ReturnType<typeof fixture.createEditor>['modified']
  ) => {
    fixture.finds.add(editor)
    return () => fixture.finds.delete(editor)
  }
}))

const onSave = vi.fn()
const onContentChange = vi.fn()
function viewer(editable: boolean) {
  return (
    <DiffViewer
      modelKey="diff-file"
      originalContent="original"
      modifiedContent="modified file"
      language="typescript"
      filePath="/repo/file.ts"
      relativePath="file.ts"
      sideBySide
      editable={editable}
      onSave={onSave}
      onContentChange={onContentChange}
    />
  )
}

function mountedEditor() {
  if (!fixture.instance) {
    throw new Error('Diff editor did not mount')
  }
  return fixture.instance
}

beforeEach(() => {
  fixture.mounts = 0
  fixture.instance = null
  onSave.mockReset()
  onContentChange.mockReset()
})
afterEach(() => {
  cleanup()
  fixture.saves.clear()
  fixture.finds.clear()
})

describe('diff editing after read-only load errors', () => {
  it('keeps one editing subscription through a repeated mount lifecycle', () => {
    const view = render(<StrictMode>{viewer(true)}</StrictMode>)
    const instance = mountedEditor()
    expect(fixture.saves.size).toBe(1)
    expect(instance.modified.changes.size).toBe(1)
    instance.modified.changes.forEach((notify) => notify())
    expect(onContentChange).toHaveBeenCalledExactlyOnceWith('modified file')
    view.unmount()
    expect(fixture.saves.size).toBe(0)
    expect(fixture.finds.size).toBe(0)
    expect(instance.modified.changes.size).toBe(0)
  })

  it('recovers save and draft callbacks without remounting or moving focus', () => {
    const view = render(viewer(false))
    const instance = mountedEditor()
    expect(fixture.saves.size).toBe(0)
    view.rerender(viewer(true))
    expect(fixture.mounts).toBe(1)
    expect(fixture.saves.size).toBe(1)
    expect(fixture.finds.size).toBe(2)
    instance.modified.changes.forEach((notify) => notify())
    fixture.saves.get(instance.modified.dom)?.()
    expect(onContentChange).toHaveBeenCalledExactlyOnceWith('modified file')
    expect(onSave).toHaveBeenCalledExactlyOnceWith('modified file')
    expect(instance.focus).toHaveBeenCalledOnce()
    expect(instance.modified.focus).not.toHaveBeenCalled()
  })

  it('removes save and draft callbacks when a live pane becomes read-only', () => {
    const view = render(viewer(true))
    const instance = mountedEditor()
    expect(fixture.saves.size).toBe(1)
    expect(instance.modified.changes.size).toBe(1)
    view.rerender(viewer(false))
    expect(fixture.saves.size).toBe(0)
    expect(fixture.finds.size).toBe(0)
    instance.modified.changes.forEach((notify) => notify())
    expect(onContentChange).not.toHaveBeenCalled()
  })

  it('cleans the editing subscriptions when the viewer unmounts', () => {
    const view = render(viewer(true))
    const instance = mountedEditor()
    view.unmount()
    expect(fixture.saves.size).toBe(0)
    expect(fixture.finds.size).toBe(0)
    expect(instance.modified.changes.size).toBe(0)
  })
})
