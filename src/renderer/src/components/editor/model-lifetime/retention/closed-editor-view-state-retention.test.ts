// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { createStore } from 'zustand/vanilla'
import { afterEach, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { createEditorModelRegistry } from '@/lib/editor/monaco/editor-model-registry'
import { attachClosedEditorTabCleanup } from '@/components/editor/model-lifetime/retention/closed-editor-tab-controller'
import { toEditorModelUri } from '@/components/editor/model-lifetime/identity/editor-model-uri'
import {
  scrollTopCache,
  editorSelectionCache,
  pdfViewPositionCache
} from '@/components/editor/model-lifetime/retention/editor-view-state-cache'

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
