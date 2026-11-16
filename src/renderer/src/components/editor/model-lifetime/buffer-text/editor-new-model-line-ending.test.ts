// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, describe, expect, it } from 'vitest'
import { applyNewModelLineEnding, trackNewModelLineEnding } from './editor-new-model-line-ending'
import { syncContentOnMount, syncContentUpdate } from './monaco-content-sync'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  isProgrammaticContentSyncInFlight,
  resetProgrammaticContentSyncForTests
} from './monaco-programmatic-sync'

const CRLF = monaco.editor.EndOfLineSequence.CRLF
const models: monaco.editor.ITextModel[] = []

/** An empty model on a Windows client, where the editor defaults to CRLF. */
function windowsModel(text = ''): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(text, 'plaintext')
  model.setEOL(CRLF)
  models.push(model)
  return model
}

function type(model: monaco.editor.ITextModel, text: string): void {
  model.pushStackElement()
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
  model.pushStackElement()
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function writeExternally(
  model: monaco.editor.ITextModel,
  content: string,
  path: 'mount' | 'update'
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this editor double delegates model edits and undo to a real Monaco model.
  const editorHost = {
    getModel: () => model,
    saveViewState: () => null,
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    }
  } as unknown as monaco.editor.IStandaloneCodeEditor
  beginProgrammaticContentSync('key')
  try {
    if (path === 'mount') {
      syncContentOnMount(editorHost, content)
    } else {
      syncContentUpdate(editorHost, content)
    }
  } finally {
    endProgrammaticContentSync('key')
  }
}

afterEach(() => {
  resetProgrammaticContentSyncForTests()
  models.splice(0).forEach((model) => model.dispose())
})

describe('line ending of a new model', () => {
  it('switches without registering as a user edit', () => {
    const model = windowsModel()
    let echoed = false
    model.onDidChangeContent(() => {
      echoed = !isProgrammaticContentSyncInFlight('key')
    })
    applyNewModelLineEnding(model, '\n', 'key')
    expect(model.getEOL()).toBe('\n')
    expect(echoed).toBe(false)
  })

  it('keeps the ending of a file loaded with line breaks', () => {
    const model = windowsModel('a\r\nb\r\n')
    const tracker = trackNewModelLineEnding(model, '\n', 'key')
    expect(model.getValue()).toBe('a\r\nb\r\n')
    tracker.dispose()
  })

  it('keeps the chosen ending after undo restores the old one', async () => {
    const model = windowsModel()
    type(model, 'typed')
    const tracker = trackNewModelLineEnding(model, '\n', 'key')
    model.undo()
    await settle()
    expect(model.getEOL()).toBe('\n')
    type(model, 'next\nline')
    await settle()
    expect(model.getValue()).toBe('next\nline')
    tracker.dispose()
  })

  it('converts lines typed before the host reported its OS', () => {
    const model = windowsModel()
    const pending = trackNewModelLineEnding(model, null, 'key')
    type(model, 'first\nsecond')
    expect(model.getValue()).toBe('first\r\nsecond')
    pending.dispose()
    const reported = trackNewModelLineEnding(model, '\n', 'key')
    expect(model.getValue()).toBe('first\nsecond')
    reported.dispose()
  })

  it('adopts the ending of external text written into a new file', async () => {
    const model = windowsModel()
    const tracker = trackNewModelLineEnding(model, '\n', 'key')
    writeExternally(model, 'a\r\nb', 'update')
    await settle()
    expect(model.getValue()).toBe('a\r\nb')
    tracker.dispose()
  })

  it('keeps external text written while no editor was mounted', async () => {
    const model = windowsModel()
    trackNewModelLineEnding(model, '\n', 'key').dispose()
    let userEdits = 0
    model.onDidChangeContent(() => {
      userEdits += isProgrammaticContentSyncInFlight('key') ? 0 : 1
    })
    writeExternally(model, 'a\r\nb', 'mount')
    const remount = trackNewModelLineEnding(model, '\n', 'key')
    await settle()
    expect(model.getValue()).toBe('a\r\nb')
    expect(userEdits).toBe(0)
    remount.dispose()
  })

  it('keeps unmounted external text when the host reports after remount', async () => {
    const model = windowsModel()
    trackNewModelLineEnding(model, null, 'key').dispose()
    writeExternally(model, 'a\nb', 'mount')
    const remount = trackNewModelLineEnding(model, '\r\n', 'key')
    await settle()
    expect(model.getValue()).toBe('a\nb')
    remount.dispose()
  })

  it('never converts a new file once its typed lines are saved', () => {
    const model = windowsModel()
    const typing = trackNewModelLineEnding(model, '\r\n', 'key')
    type(model, 'one\ntwo')
    typing.dispose()
    // Saved to disk, then End of Line changes to LF.
    const saved = trackNewModelLineEnding(model, '\r\n', 'key', true)
    saved.dispose()
    const changed = trackNewModelLineEnding(model, '\n', 'key', true)
    expect(model.getValue()).toBe('one\r\ntwo')
    changed.dispose()
  })

  it('stays an existing file after it becomes dirty again', () => {
    const model = windowsModel()
    trackNewModelLineEnding(model, '\r\n', 'key').dispose()
    type(model, 'one\ntwo')
    trackNewModelLineEnding(model, '\r\n', 'key', true).dispose()
    type(model, 'one\ntwo\nthree')
    const changed = trackNewModelLineEnding(model, '\n', 'key', false)
    expect(model.getValue()).toBe('one\r\ntwo\r\nthree')
    changed.dispose()
  })

  it('keeps undo offsets valid across a late conversion of typed lines', async () => {
    const model = windowsModel()
    const pending = trackNewModelLineEnding(model, null, 'key')
    type(model, 'a\nbc')
    model.pushEditOperations(
      [],
      [
        { range: { startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 2 }, text: 'X' }
      ],
      () => null
    )
    model.pushStackElement()
    pending.dispose()
    const known = trackNewModelLineEnding(model, '\n', 'key')
    expect(model.getValue()).toBe('a\nbXc')
    // Undo first reverts the conversion, then the typed X, without being trapped.
    model.undo()
    await settle()
    expect(model.getValue()).toBe('a\r\nbXc')
    model.undo()
    await settle()
    expect(model.getValue()).toBe('a\r\nbc')
    model.redo()
    await settle()
    model.redo()
    await settle()
    expect(model.getValue()).toBe('a\nbXc')
    known.dispose()
  })

  it('keeps undo and redo consistent when typing after a late conversion', async () => {
    const model = windowsModel()
    const pending = trackNewModelLineEnding(model, null, 'key')
    type(model, 'line1\nline2\nline3')
    pending.dispose()
    const known = trackNewModelLineEnding(model, '\n', 'key')
    model.pushEditOperations(
      [],
      [
        { range: { startLineNumber: 3, startColumn: 6, endLineNumber: 3, endColumn: 6 }, text: 'Z' }
      ],
      () => null
    )
    model.pushStackElement()
    const states: string[] = []
    for (const step of ['undo', 'undo', 'redo', 'redo'] as const) {
      model[step]()
      await settle()
      states.push(model.getValue())
    }
    expect(states).toEqual([
      'line1\nline2\nline3',
      'line1\r\nline2\r\nline3',
      'line1\nline2\nline3',
      'line1\nline2\nline3Z'
    ])
    known.dispose()
  })
})
