// @vitest-environment happy-dom
import * as monaco from 'monaco-editor'
import { afterEach, describe, expect, it } from 'vitest'
import { syncContentUpdate } from './monaco-content-sync'

const models: monaco.editor.ITextModel[] = []

function createEditor(initialContent: string): {
  editorInstance: monaco.editor.IStandaloneCodeEditor
  model: monaco.editor.ITextModel
} {
  const model = monaco.editor.createModel(initialContent, 'plaintext')
  models.push(model)
  return {
    model,
    editorInstance: {
      getModel: () => model,
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

    expect(model.getValue()).toBe('first line\nappended')
    expect(model.canUndo()).toBe(false)
  })

  it('keeps ordinary external updates undoable', async () => {
    const { editorInstance, model } = createEditor('editable')

    syncContentUpdate(editorInstance, 'external update')

    expect(model.canUndo()).toBe(true)
    await model.undo()
    expect(model.getValue()).toBe('editable')
  })
})
