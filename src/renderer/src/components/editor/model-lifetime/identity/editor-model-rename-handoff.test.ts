// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'

// Why: the carry hook reads drafts from the app store; point it at the fixture's editor store.
const storeState = vi.hoisted(() => {
  const holder: { current: (() => unknown) | null } = { current: null }
  return holder
})
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => storeState.current?.() }
}))

import { editorModelRegistry } from '@/lib/editor/monaco/editor-model-registry'
import {
  createModelLifetimeFixture,
  resetModelLifetimeFixtures
} from '../retention/editor-model-lifetime-fixture'
import { trackNewModelLineEnding } from '../buffer-text/editor-new-model-line-ending'
import { resetProgrammaticContentSyncForTests } from '../buffer-text/monaco-programmatic-sync'
import { useEditorModelRekeyCarry } from './editor-model-rekey-carry'
import { takeRenamedBufferLineEnding } from './editor-model-rename-handoff'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { toEditorModelUri } from './editor-model-uri'

const models: monaco.editor.ITextModel[] = []
const trackers: { dispose(): void }[] = []
const unregisters: (() => void)[] = []
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function type(target: monaco.editor.ITextModel, text: string): void {
  target.pushStackElement()
  target.pushEditOperations([], [{ range: target.getFullModelRange(), text }], () => null)
  target.pushStackElement()
}

/** Native Windows with Auto: the choice is CRLF. */
function track(target: monaco.editor.ITextModel): void {
  trackers.push(trackNewModelLineEnding(target, '\r\n', target.uri.toString()))
}

function setup() {
  const fixture = createModelLifetimeFixture()
  unregisters.push(editorModelRegistry.register(monaco))
  storeState.current = () => fixture.store.getState()
  return fixture
}

type FixtureStore = ReturnType<typeof setup>['store']

function rename(store: FixtureStore, fileId: string, newFileId: string, newFilePath: string) {
  const file = store.getState().openFiles.find((entry) => entry.id === fileId)
  if (!file) {
    throw new Error(`no open file ${fileId}`)
  }
  return store.getState().rekeyOpenFilesForPathChange({
    rekeys: [
      {
        oldFileId: fileId,
        newFileId,
        oldFilePath: file.filePath,
        newFilePath,
        newRelativePath: newFilePath.split('/').pop() ?? newFilePath
      }
    ]
  })
}

/** Mounts the renamed tab's editor: the carry hook, then the editor library's own model. */
function mount(store: FixtureStore, viewId: string): monaco.editor.ITextModel {
  const state = store.getState()
  const file = state.openFiles.find((entry) => entry.id === viewId)
  if (!file) {
    throw new Error(`no open file ${viewId}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the editor store fixture holds every editor slice the owner key reads.
  const uri = toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state as AppState))
  renderHook(() => useEditorModelRekeyCarry(viewId, uri))
  const target =
    monaco.editor.getModel(monaco.Uri.parse(uri)) ??
    monaco.editor.createModel(state.editorDrafts[viewId] ?? '', 'plaintext', monaco.Uri.parse(uri))
  models.push(target)
  track(target)
  return target
}

afterEach(() => {
  cleanup()
  trackers.splice(0).forEach((tracker) => tracker.dispose())
  unregisters.splice(0).forEach((unregister) => unregister())
  resetModelLifetimeFixtures()
  models.splice(0).forEach((entry) => {
    if (!entry.isDisposed()) {
      entry.dispose()
    }
  })
  storeState.current = null
  resetProgrammaticContentSyncForTests()
})

describe('rename handoff of a buffer line ending', () => {
  it('keeps an emptied LF file on LF after a background rename disposed its model', async () => {
    const { store, add, attach } = setup()
    const { file, model } = add('background')
    model.setValue('a\nb\n')
    model.setEOL(monaco.editor.EndOfLineSequence.LF)
    track(model)
    type(model, '')
    store.getState().setEditorDraft(file.id, '')
    store.getState().markFileDirty(file.id, true)
    await settle()
    attach()
    expect(rename(store, file.id, 'renamed', '/fixture/workspace/renamed.txt').ok).toBe(true)
    await settle()
    await settle()
    expect(model.isDisposed()).toBe(true)
    const next = mount(store, 'renamed')
    type(next, 'x\ny')
    expect(next.getValue()).toBe('x\ny')
  })

  it('drops a closed tab’s snapshot so a reused id starts fresh', async () => {
    const { store, add, attach } = setup()
    const { file, model } = add('closing')
    model.setValue('a\nb\n')
    model.setEOL(monaco.editor.EndOfLineSequence.LF)
    track(model)
    type(model, '')
    store.getState().setEditorDraft(file.id, '')
    store.getState().markFileDirty(file.id, true)
    await settle()
    attach()
    const reused = '/fixture/workspace/reused.txt'
    expect(rename(store, file.id, reused, reused).ok).toBe(true)
    store.getState().closeFile(reused)
    await settle()
    expect(takeRenamedBufferLineEnding(reused)).toBeUndefined()
    // A new one-line draft at the same id and path follows the editor's choice.
    store.setState({
      openFiles: [{ ...file, id: reused, filePath: reused, isDirty: true }],
      editorDrafts: { [reused]: 'new draft' }
    })
    const next = mount(store, reused)
    type(next, 'new draft\nsecond')
    expect(next.getValue()).toBe('new draft\r\nsecond')
  })

  it('records nothing for a clean tab', () => {
    const { store, add } = setup()
    const { file } = add('clean')
    expect(rename(store, file.id, 'clean-renamed', '/fixture/workspace/clean.txt').ok).toBe(true)
    expect(takeRenamedBufferLineEnding('clean-renamed')).toBeUndefined()
  })
})
