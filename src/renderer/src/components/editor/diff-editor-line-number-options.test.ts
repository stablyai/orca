import { describe, expect, it } from 'vitest'
import {
  applyDiffEditorLineNumberOptions,
  buildDiffEditorLineNumberOptions
} from './diff-editor-line-number-options'
import type { editor } from 'monaco-editor'

describe('buildDiffEditorLineNumberOptions', () => {
  it('hides original line numbers in inline mode', () => {
    expect(buildDiffEditorLineNumberOptions(false)).toEqual({
      original: 'off',
      modified: 'on'
    })
  })

  it('shows both gutters in side-by-side mode', () => {
    expect(buildDiffEditorLineNumberOptions(true)).toEqual({
      original: 'on',
      modified: 'on'
    })
  })
})

function createMockCodeEditor(initialLineNumbers: editor.LineNumbersType = 'on'): {
  editor: editor.ICodeEditor
  emitDidChangeConfiguration: () => void
  getLineNumbers: () => editor.LineNumbersType
} {
  let lineNumbers: editor.LineNumbersType = initialLineNumbers
  const listeners = new Set<() => void>()

  const mockEditor = {
    getRawOptions: () => ({ lineNumbers }),
    updateOptions: ({ lineNumbers: nextLineNumbers }: { lineNumbers?: editor.LineNumbersType }) => {
      if (nextLineNumbers) {
        lineNumbers = nextLineNumbers
      }
    },
    onDidChangeConfiguration: (listener: () => void) => {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
        }
      }
    }
  } as unknown as editor.ICodeEditor

  return {
    editor: mockEditor,
    emitDidChangeConfiguration: () => {
      listeners.forEach((listener) => listener())
    },
    getLineNumbers: () => lineNumbers
  }
}

describe('applyDiffEditorLineNumberOptions', () => {
  it('reapplies desired line number options after parent option updates and stops after dispose', () => {
    const original = createMockCodeEditor('on')
    const modified = createMockCodeEditor('on')
    const diffEditor = {
      getOriginalEditor: () => original.editor,
      getModifiedEditor: () => modified.editor
    } as unknown as editor.IStandaloneDiffEditor

    const disposable = applyDiffEditorLineNumberOptions(diffEditor, false)

    expect(original.getLineNumbers()).toBe('off')
    expect(modified.getLineNumbers()).toBe('on')

    original.editor.updateOptions({ lineNumbers: 'on' })
    original.emitDidChangeConfiguration()
    expect(original.getLineNumbers()).toBe('off')

    disposable.dispose()
    original.editor.updateOptions({ lineNumbers: 'on' })
    original.emitDidChangeConfiguration()
    expect(original.getLineNumbers()).toBe('on')
  })
})
