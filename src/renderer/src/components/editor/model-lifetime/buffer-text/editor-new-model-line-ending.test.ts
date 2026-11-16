// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, describe, expect, it } from 'vitest'
import { applyNewModelLineEnding, trackNewModelLineEnding } from './editor-new-model-line-ending'
import { syncContentUpdate } from './monaco-content-sync'
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the live-tail sync path reads only getModel from its editor.
    const editorHost = { getModel: () => model } as unknown as monaco.editor.IStandaloneCodeEditor
    beginProgrammaticContentSync('key')
    try {
      syncContentUpdate(editorHost, 'a\r\nb', 'read-only-live-tail')
    } finally {
      endProgrammaticContentSync('key')
    }
    await settle()
    expect(model.getValue()).toBe('a\r\nb')
    tracker.dispose()
  })
})
