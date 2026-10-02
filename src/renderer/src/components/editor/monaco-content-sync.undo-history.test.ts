// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, describe, expect, it } from 'vitest'
import { syncContentUpdate } from './monaco-content-sync'

const models: monaco.editor.ITextModel[] = []

function createEditor(
  initialContent: string,
  initialSelections: monaco.ISelection[] = []
): {
  editorInstance: monaco.editor.IStandaloneCodeEditor
  model: monaco.editor.ITextModel
  getSelections: () => monaco.ISelection[]
} {
  const model = monaco.editor.createModel(initialContent, 'plaintext')
  models.push(model)
  let selections = initialSelections
  return {
    model,
    getSelections: () => selections,
    editorInstance: {
      getModel: () => model,
      getSelections: () => selections,
      setSelections: (next: monaco.ISelection[]) => {
        selections = next
      },
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

describe('Monaco external-content cursor preservation', () => {
  it('keeps the caret where it was when a rewrite replaces the whole file', () => {
    const { editorInstance, getSelections } = createEditor('const a=1\nconst b=2\nconst c=3', [
      {
        selectionStartLineNumber: 2,
        selectionStartColumn: 8,
        positionLineNumber: 2,
        positionColumn: 8
      }
    ])

    syncContentUpdate(editorInstance, 'const a = 1\nconst b = 2\nconst c = 3')

    expect(getSelections()).toEqual([
      {
        selectionStartLineNumber: 2,
        selectionStartColumn: 8,
        positionLineNumber: 2,
        positionColumn: 8
      }
    ])
  })

  it('clamps a caret that the rewrite pushed past the end of the file', () => {
    const { editorInstance, getSelections } = createEditor('line one\nline two\nline three', [
      {
        selectionStartLineNumber: 3,
        selectionStartColumn: 11,
        positionLineNumber: 3,
        positionColumn: 11
      }
    ])

    syncContentUpdate(editorInstance, 'line one')

    expect(getSelections()).toEqual([
      {
        selectionStartLineNumber: 1,
        selectionStartColumn: 9,
        positionLineNumber: 1,
        positionColumn: 9
      }
    ])
  })

  it('leaves read-only live-tail selections alone', () => {
    const { editorInstance, getSelections } = createEditor('log line', [
      {
        selectionStartLineNumber: 1,
        selectionStartColumn: 2,
        positionLineNumber: 1,
        positionColumn: 2
      }
    ])

    syncContentUpdate(editorInstance, 'totally different', 'read-only-live-tail')

    expect(getSelections()).toEqual([
      {
        selectionStartLineNumber: 1,
        selectionStartColumn: 2,
        positionLineNumber: 1,
        positionColumn: 2
      }
    ])
  })
})
