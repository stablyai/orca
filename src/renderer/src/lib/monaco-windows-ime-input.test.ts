import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { installMonacoWindowsImeInput } from './monaco-windows-ime-input'

function createMockMonaco() {
  const create = vi.fn(
    (_element: HTMLElement, _options?: editor.IStandaloneEditorConstructionOptions) =>
      ({}) as editor.IStandaloneCodeEditor
  )
  const createDiffEditor = vi.fn(
    (_element: HTMLElement, _options?: editor.IStandaloneDiffEditorConstructionOptions) =>
      ({}) as editor.IStandaloneDiffEditor
  )
  return { monaco: { editor: { create, createDiffEditor } }, create, createDiffEditor }
}

describe('installMonacoWindowsImeInput', () => {
  it('turns off EditContext for code editors on Windows', () => {
    const { monaco, create } = createMockMonaco()

    installMonacoWindowsImeInput(monaco, true)
    monaco.editor.create({} as HTMLElement, { readOnly: true })

    expect(create).toHaveBeenCalledWith({}, { readOnly: true, editContext: false }, undefined)
  })

  it('turns off EditContext for diff editors on Windows', () => {
    const { monaco, createDiffEditor } = createMockMonaco()

    installMonacoWindowsImeInput(monaco, true)
    monaco.editor.createDiffEditor({} as HTMLElement)

    expect(createDiffEditor).toHaveBeenCalledWith({}, { editContext: false }, undefined)
  })

  it('keeps an explicit editContext choice from the caller', () => {
    const { monaco, create } = createMockMonaco()

    installMonacoWindowsImeInput(monaco, true)
    monaco.editor.create({} as HTMLElement, { editContext: true })

    expect(create).toHaveBeenCalledWith({}, { editContext: true }, undefined)
  })

  it('leaves Monaco factories untouched off Windows', () => {
    const { monaco, create, createDiffEditor } = createMockMonaco()

    installMonacoWindowsImeInput(monaco, false)

    expect(monaco.editor.create).toBe(create)
    expect(monaco.editor.createDiffEditor).toBe(createDiffEditor)
  })

  it('keeps installation idempotent', () => {
    const { monaco, create } = createMockMonaco()

    installMonacoWindowsImeInput(monaco, true)
    installMonacoWindowsImeInput(monaco, true)
    monaco.editor.create({} as HTMLElement)

    expect(create).toHaveBeenCalledTimes(1)
  })
})
