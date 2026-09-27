// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { createStore } from 'zustand/vanilla'
import { afterEach, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { createEditorModelRegistry } from '@/lib/editor-model-registry'
import { attachClosedEditorTabCleanup } from '@/components/editor/closed-editor-tab-controller'
import { toEditorModelUri } from '@/components/editor/editor-model-uri'
import {
  scrollTopCache,
  editorSelectionCache,
  pdfViewPositionCache,
  setWithLRU
} from '@/lib/scroll-cache'

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
  // Mirrors `MonacoEditor`: the `path` prop is what `@monaco-editor/react` hands to `Uri.parse`.
  const model = monaco.editor.createModel(
    text,
    'plaintext',
    monaco.Uri.parse(toEditorModelUri(path))
  )
  const store = createStore(() => ({ openFiles: [file] }))
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

it('retires the actual model while retaining existing bounded scroll, selection and PDF state', async () => {
  const path = '/tradeoff/view-state.txt'
  const owner = open(path)
  const selection = [
    {
      selectionStartLineNumber: 3,
      selectionStartColumn: 2,
      positionLineNumber: 3,
      positionColumn: 7
    }
  ]
  setWithLRU(scrollTopCache, path, 234)
  setWithLRU(editorSelectionCache, path, selection)
  setWithLRU(pdfViewPositionCache, `${path}:pdf`, { pageNumber: 2, top: 12, left: 0 })
  await owner.close()
  expect(scrollTopCache.get(path)).toBe(234)
  expect(editorSelectionCache.get(path)).toEqual(selection)
  expect(pdfViewPositionCache.get(`${path}:pdf`)).toEqual({ pageNumber: 2, top: 12, left: 0 })
})

it('preserves the existing 20-entry LRU across 40 closed models without retaining the models', async () => {
  for (let index = 0; index < 40; index += 1) {
    const path = `/tradeoff/lru-${index}.txt`
    const owner = open(path)
    setWithLRU(scrollTopCache, path, index)
    await owner.close()
  }
  expect(monaco.editor.getModels()).toHaveLength(0)
  expect(scrollTopCache.size).toBe(20)
  expect(scrollTopCache.get('/tradeoff/lru-39.txt')).toBe(39)
  expect(scrollTopCache.has('/tradeoff/lru-0.txt')).toBe(false)
})

it('measures the existing Monaco large-file undo retention limit', async () => {
  const path = '/tradeoff/undo-large-file.txt'
  const owner = open(path, 'x'.repeat(10 * 1024 * 1024 + 1))
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
  expect(reopened.canUndo()).toBe(false)
})

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

// Guards the construction/comparison symmetry: the disposal lookup and the still-open ownership
// check must normalize a path the same way, or closing one tab drops a model another tab is editing.
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
