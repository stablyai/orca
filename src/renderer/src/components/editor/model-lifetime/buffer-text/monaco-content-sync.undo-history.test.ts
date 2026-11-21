// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, describe, expect, it } from 'vitest'
import { syncContentOnMount, syncContentUpdate } from './monaco-content-sync'

const models: monaco.editor.ITextModel[] = []

function createEditor(initialContent: string): {
  editorInstance: monaco.editor.IStandaloneCodeEditor
  model: monaco.editor.ITextModel
} {
  const model = monaco.editor.createModel(initialContent, 'plaintext')
  models.push(model)
  return {
    model,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this editor double delegates model edits and undo to a real Monaco model.
    editorInstance: {
      getModel: () => model,
      saveViewState: () => null,
      pushUndoStop: () => {
        model.pushStackElement()
        return true
      }
    } as unknown as monaco.editor.IStandaloneCodeEditor
  }
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
})

describe('Monaco external-content undo history', () => {
  it('does not make a read-only live-tail append undoable', () => {
    const { editorInstance, model } = createEditor('first line')

    syncContentUpdate(editorInstance, 'first line\nappended', 'read-only-live-tail')

    expect(model.canUndo()).toBe(false)
  })

  it('keeps ordinary external updates undoable', async () => {
    const { editorInstance, model } = createEditor('editable')

    syncContentUpdate(editorInstance, 'external update')

    expect(model.canUndo()).toBe(true)
    await model.undo()
    expect(model.getValue()).toBe('editable')
  })

  it('keeps a CRLF model CRLF when a reset leaves a single line', () => {
    const { editorInstance, model } = createEditor('a\r\nb')

    syncContentOnMount(editorInstance, 'a', 'reset-history')

    expect(model.getEOL()).toBe('\r\n')
  })
})
