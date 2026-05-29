import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import {
  guardMonacoDiffEditorDispose,
  installMonacoDiffEditorDisposalGuard
} from './monaco-diff-editor-disposal'

function createMockDiffEditor(dispose: () => void): editor.IStandaloneDiffEditor {
  return { dispose } as unknown as editor.IStandaloneDiffEditor
}

describe('guardMonacoDiffEditorDispose', () => {
  it('contains Monaco disposal errors after invoking the real dispose path', () => {
    const disposeError = new AggregateError(
      [new Error('inner dispose failed')],
      'Encountered errors while disposing of store'
    )
    const reportError = vi.fn()
    const originalDispose = vi.fn(() => {
      throw disposeError
    })
    const diffEditor = createMockDiffEditor(originalDispose)

    guardMonacoDiffEditorDispose(diffEditor, reportError)

    expect(() => diffEditor.dispose()).not.toThrow()
    expect(originalDispose).toHaveBeenCalledTimes(1)
    expect(reportError).toHaveBeenCalledWith(disposeError)
  })

  it('does not repeatedly dispose an editor after the guarded disposal has run', () => {
    const originalDispose = vi.fn()
    const diffEditor = createMockDiffEditor(originalDispose)

    guardMonacoDiffEditorDispose(diffEditor)
    diffEditor.dispose()
    diffEditor.dispose()

    expect(originalDispose).toHaveBeenCalledTimes(1)
  })
})

describe('installMonacoDiffEditorDisposalGuard', () => {
  it('wraps diff editors created by Monaco and keeps factory installation idempotent', () => {
    const disposeError = new AggregateError(
      [new Error('inner dispose failed')],
      'Encountered errors while disposing of store'
    )
    const reportError = vi.fn()
    const originalDispose = vi.fn(() => {
      throw disposeError
    })
    const createDiffEditor = vi.fn((_element: HTMLElement) => createMockDiffEditor(originalDispose))
    const monaco = {
      editor: {
        createDiffEditor
      }
    }

    installMonacoDiffEditorDisposalGuard(monaco, reportError)
    installMonacoDiffEditorDisposalGuard(monaco, reportError)

    const diffEditor = monaco.editor.createDiffEditor({} as HTMLElement)

    expect(createDiffEditor).toHaveBeenCalledTimes(1)
    expect(() => diffEditor.dispose()).not.toThrow()
    expect(originalDispose).toHaveBeenCalledTimes(1)
    expect(reportError).toHaveBeenCalledWith(disposeError)
  })
})
