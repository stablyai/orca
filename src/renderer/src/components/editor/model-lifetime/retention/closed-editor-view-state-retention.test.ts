// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { createStore } from 'zustand/vanilla'
import { afterEach, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { createEditorModelRegistry } from '@/lib/editor/monaco/editor-model-registry'
import { attachClosedEditorTabCleanup } from '@/components/editor/model-lifetime/retention/closed-editor-tab-controller'
import { toEditorModelUri } from '@/components/editor/model-lifetime/identity/editor-model-uri'
import { scrollTopCache, editorSelectionCache, pdfViewPositionCache } from '@/lib/scroll-cache'

const disposeOwners: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposeOwners.splice(0)) {
    dispose()
  }
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
  scrollTopCache.clear()
  editorSelectionCache.clear()
  pdfViewPositionCache.clear()
})

function open(path: string, text = 'original') {
  const file: OpenFile = {
    id: path,
    worktreeId: 'fixture',
    filePath: path,
    relativePath: path,
    mode: 'edit',
    language: 'plaintext',
    isDirty: false
  }
  // Match the React wrapper’s path-to-Uri.parse conversion.
  const model = monaco.editor.createModel(
    text,
    'plaintext',
    monaco.Uri.parse(toEditorModelUri(path))
  )
  const store = createStore(() => ({
    openFiles: [file],
    worktreesByRepo: { fixture: [{ id: 'fixture', repoId: 'fixture', hostId: 'local' as const }] }
  }))
  const bridge = createEditorModelRegistry()
  disposeOwners.push(bridge.register(monaco), attachClosedEditorTabCleanup(store, bridge))
  return {
    model,
    close: async () => {
      store.setState({ openFiles: [] })
      await Promise.resolve()
      expect(model.isDisposed()).toBe(true)
    }
  }
}

it.each([
  '/tradeoff/undo-posix.txt',
  'file:///C:/tradeoff/undo-file-uri.txt',
  'C:/tradeoff/undo-raw-drive.txt',
  'C:\\tradeoff\\undo-raw-drive-backslash.txt',
  '\\\\server\\share\\undo-unc.txt'
] as const)('restores closed-file undo after reopening %s', async (path) => {
  const owner = open(path)
  owner.model.pushEditOperations(
    [],
    [{ range: new monaco.Range(1, 1, 1, 1), text: 'saved ' }],
    () => null
  )
  owner.model.pushStackElement()
  expect(owner.model.canUndo()).toBe(true)
  const content = owner.model.getValue()
  await owner.close()
  const reopened = monaco.editor.createModel(
    content,
    'plaintext',
    monaco.Uri.parse(toEditorModelUri(path))
  )
  expect(reopened.canUndo()).toBe(true)
  await reopened.undo()
  expect(reopened.getValue()).toBe('original')
})

// Disposal and ownership lookup must normalize Windows paths identically or one close can destroy another tab’s model.
it('keeps a Windows-path model that a second open tab still owns', async () => {
  const filePath = 'C:\\repo\\shared.ts'
  const editing: OpenFile = {
    id: 'tab-a',
    worktreeId: 'fixture',
    filePath,
    relativePath: filePath,
    mode: 'edit',
    language: 'plaintext',
    isDirty: false
  }
  const modelUri = monaco.Uri.parse(toEditorModelUri(filePath))
  const model = monaco.editor.createModel('live', 'plaintext', modelUri)
  const store = createStore(() => ({ openFiles: [editing, { ...editing, id: 'tab-b' }] }))
  const bridge = createEditorModelRegistry()
  disposeOwners.push(bridge.register(monaco), attachClosedEditorTabCleanup(store, bridge))

  store.setState({ openFiles: [editing] })
  await Promise.resolve()

  expect(model.isDisposed()).toBe(false)
  expect(monaco.editor.getModel(modelUri)).toBe(model)
})
