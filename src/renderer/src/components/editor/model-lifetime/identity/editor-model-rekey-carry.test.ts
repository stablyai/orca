// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, describe, expect, it } from 'vitest'
import { trackNewModelLineEnding } from '../buffer-text/editor-new-model-line-ending'
import { resetProgrammaticContentSyncForTests } from '../buffer-text/monaco-programmatic-sync'
import { carryEditorModelText } from './editor-model-rekey-carry'

const models: monaco.editor.ITextModel[] = []
const trackers: { dispose(): void }[] = []
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function model(text: string, uri: string): monaco.editor.ITextModel {
  const created = monaco.editor.createModel(text, 'plaintext', monaco.Uri.parse(uri))
  models.push(created)
  return created
}

function modelAt(uri: string): monaco.editor.ITextModel {
  const found = monaco.editor.getModel(monaco.Uri.parse(uri))
  if (!found) {
    throw new Error(`no model at ${uri}`)
  }
  models.push(found)
  return found
}

/** Native Windows with Auto: the choice is CRLF. */
function track(target: monaco.editor.ITextModel, uri: string): void {
  trackers.push(trackNewModelLineEnding(target, '\r\n', uri))
}

function type(target: monaco.editor.ITextModel, text: string): void {
  target.pushStackElement()
  target.pushEditOperations([], [{ range: target.getFullModelRange(), text }], () => null)
  target.pushStackElement()
}

afterEach(() => {
  trackers.splice(0).forEach((tracker) => tracker.dispose())
  models.splice(0).forEach((entry) => {
    if (!entry.isDisposed()) {
      entry.dispose()
    }
  })
  resetProgrammaticContentSyncForTests()
})

describe('model rekey keeps an existing file on its line ending', () => {
  it('carries an emptied LF file to its replacement model', async () => {
    const from = 'file:///rekey/before.txt'
    const to = 'file:///rekey/after.txt'
    const old = model('a\nb\n', from)
    track(old, from)
    type(old, '')
    await settle()
    expect(carryEditorModelText(monaco, from, to, '')).toBe(true)
    const next = modelAt(to)
    track(next, to)
    type(next, 'x\ny')
    expect(next.getValue()).toBe('x\ny')
  })

  it('carries an LF file reduced to one line to its replacement model', async () => {
    const from = 'file:///rekey/one-before.txt'
    const to = 'file:///rekey/one-after.txt'
    const old = model('a\nb\n', from)
    track(old, from)
    type(old, 'a')
    await settle()
    expect(carryEditorModelText(monaco, from, to, 'a')).toBe(true)
    const next = modelAt(to)
    track(next, to)
    type(next, 'a\ny')
    expect(next.getValue()).toBe('a\ny')
  })

  it('leaves an unrelated model already at the destination untouched', async () => {
    const from = 'file:///rekey/source.txt'
    const to = 'file:///rekey/taken.txt'
    const old = model('a\nb\n', from)
    track(old, from)
    type(old, '')
    await settle()
    const taken = model('', to)
    taken.setEOL(monaco.editor.EndOfLineSequence.CRLF)
    expect(carryEditorModelText(monaco, from, to, '')).toBe(false)
    track(taken, to)
    type(taken, 'x\ny')
    expect(taken.getValue()).toBe('x\r\ny')
  })
})
