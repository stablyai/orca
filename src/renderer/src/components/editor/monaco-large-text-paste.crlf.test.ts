// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { editor as monacoEditor, Selection } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { executeMonacoLargeTextPaste, type MonacoPasteEditor } from './monaco-large-text-paste'

const models: monacoEditor.ITextModel[] = []

function makeEditor() {
  const model = monacoEditor.createModel('', 'plaintext')
  models.push(model)
  let selection = new Selection(1, 1, 1, 1)
  const editor: MonacoPasteEditor = {
    getModel: () => model,
    getContainerDomNode: () => document.body,
    hasTextFocus: () => true,
    getSelection: () => selection,
    setSelection: (range) => {
      selection = new Selection(
        range.startLineNumber,
        range.startColumn,
        range.endLineNumber,
        range.endColumn
      )
    },
    executeEdits: (_source, edits) => {
      model.pushEditOperations([selection], edits, () => null)
      return true
    },
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    }
  }
  return { editor, model }
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
})

describe('chunked Monaco paste CRLF boundaries', () => {
  it.each([1, 4])('keeps one newline with a %i-byte chunk budget', async (chunkMaxBytes) => {
    const { editor, model } = makeEditor()
    await executeMonacoLargeTextPaste(editor, 'aaa\r\nb', {
      chunkMaxBytes,
      yieldToEventLoop: async () => {}
    })
    expect(model.getValue()).toBe('aaa\nb')
  })
})
