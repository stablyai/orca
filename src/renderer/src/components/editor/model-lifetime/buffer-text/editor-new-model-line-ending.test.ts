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
  it('switches a one-line model without registering as a user edit', () => {
    const model = windowsModel()
    let echoed = false
    model.onDidChangeContent(() => {
      echoed = !isProgrammaticContentSyncInFlight('key')
    })
    applyNewModelLineEnding(model, '\n', 'key')
    expect(model.getEOL()).toBe('\n')
    expect(echoed).toBe(false)
  })

  it('leaves lines typed before a late host report untouched and clean of edits', async () => {
    const model = windowsModel()
    trackNewModelLineEnding(model, null, 'key').dispose()
    // Typed while an in-flight save of `one\ntwo` is still writing.
    type(model, 'one\ntwo')
    type(model, 'one\ntwoX')
    let events = 0
    model.onDidChangeContent(() => {
      events += 1
    })
    const reported = trackNewModelLineEnding(model, '\n', 'key')
    await settle()
    expect(model.getValue()).toBe('one\r\ntwoX')
    expect(events).toBe(0)
    model.undo()
    await settle()
    expect(model.getValue()).toBe('one\r\ntwo')
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
    trackNewModelLineEnding(model, null, 'key').dispose()
    let userEdits = 0
    model.onDidChangeContent(() => {
      userEdits += isProgrammaticContentSyncInFlight('key') ? 0 : 1
    })
    writeExternally(model, 'a\nb', 'mount')
    const remount = trackNewModelLineEnding(model, '\r\n', 'key')
    await settle()
    expect(model.getValue()).toBe('a\nb')
    expect(userEdits).toBe(0)
    remount.dispose()
  })
  it('keeps an LF file on LF after it is emptied and retyped', async () => {
    const model = windowsModel()
    model.setValue('a\nb\n')
    model.setEOL(monaco.editor.EndOfLineSequence.LF)
    const tracker = trackNewModelLineEnding(model, '\r\n', 'key')
    type(model, '')
    await settle()
    type(model, 'x\ny')
    expect(model.getValue()).toBe('x\ny')
    tracker.dispose()
  })

  it('keeps a CRLF file on CRLF after it is emptied and retyped', async () => {
    const model = windowsModel('a\r\nb\r\n')
    const tracker = trackNewModelLineEnding(model, '\n', 'key')
    type(model, '')
    await settle()
    type(model, 'x\ny')
    expect(model.getValue()).toBe('x\r\ny')
    tracker.dispose()
  })

  it('still re-applies the choice when Undo empties lines typed into a new file', async () => {
    const model = windowsModel()
    type(model, 'x')
    const tracker = trackNewModelLineEnding(model, '\n', 'key')
    type(model, 'one\ntwo')
    model.undo()
    await settle()
    model.undo()
    await settle()
    expect(model.getValue()).toBe('')
    expect(model.getEOL()).toBe('\n')
    tracker.dispose()
  })

  it('keeps the ending of text written while hidden after the file is emptied', async () => {
    const model = windowsModel()
    trackNewModelLineEnding(model, null, 'key').dispose()
    writeExternally(model, 'a\nb', 'mount')
    const remount = trackNewModelLineEnding(model, '\r\n', 'key')
    type(model, '')
    await settle()
    type(model, 'x\ny')
    expect(model.getValue()).toBe('x\ny')
    remount.dispose()
  })
})
