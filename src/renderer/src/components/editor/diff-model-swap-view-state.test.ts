// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { preserveDiffViewStateAcrossModelSwaps } from './diff-model-swap-view-state'

type ModelListener = () => void

function modelEditorFixture() {
  let willChangeListener: ModelListener = () => {}
  let didChangeListener: ModelListener = () => {}
  const disposeWillChange = vi.fn()
  const disposeDidChange = vi.fn()
  return {
    editor: {
      onWillChangeModel: (listener: ModelListener) => {
        willChangeListener = listener
        return { dispose: disposeWillChange }
      },
      onDidChangeModel: (listener: ModelListener) => {
        didChangeListener = listener
        return { dispose: disposeDidChange }
      }
    } as unknown as editor.ICodeEditor,
    fireWillChange: () => willChangeListener(),
    fireDidChange: () => didChangeListener(),
    disposeWillChange,
    disposeDidChange
  }
}

describe('diff model swap view state', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('coalesces a two-sided model rotation into one view-state restore', () => {
    const original = modelEditorFixture()
    const modified = modelEditorFixture()
    const viewState = { original: {}, modified: {} } as editor.IDiffEditorViewState
    const diffEditor = {
      getOriginalEditor: () => original.editor,
      getModifiedEditor: () => modified.editor,
      getModel: () => ({ original: {}, modified: {} }),
      saveViewState: vi.fn(() => viewState),
      restoreViewState: vi.fn()
    } as unknown as editor.IStandaloneDiffEditor
    const scheduledFrames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    preserveDiffViewStateAcrossModelSwaps(diffEditor)
    original.fireWillChange()
    original.fireDidChange()
    modified.fireWillChange()
    modified.fireDidChange()

    expect(diffEditor.saveViewState).toHaveBeenCalledOnce()
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1)
    scheduledFrames[1](0)
    expect(diffEditor.restoreViewState).toHaveBeenCalledOnce()
    expect(diffEditor.restoreViewState).toHaveBeenCalledWith(viewState)
  })

  it('cancels pending work and listeners when the editor is disposed', () => {
    const original = modelEditorFixture()
    const modified = modelEditorFixture()
    const diffEditor = {
      getOriginalEditor: () => original.editor,
      getModifiedEditor: () => modified.editor,
      saveViewState: () => ({ original: {}, modified: {} }),
      restoreViewState: vi.fn()
    } as unknown as editor.IStandaloneDiffEditor
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const subscription = preserveDiffViewStateAcrossModelSwaps(diffEditor)

    modified.fireWillChange()
    modified.fireDidChange()
    subscription.dispose()

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(7)
    expect(original.disposeWillChange).toHaveBeenCalledOnce()
    expect(original.disposeDidChange).toHaveBeenCalledOnce()
    expect(modified.disposeWillChange).toHaveBeenCalledOnce()
    expect(modified.disposeDidChange).toHaveBeenCalledOnce()
  })
})
