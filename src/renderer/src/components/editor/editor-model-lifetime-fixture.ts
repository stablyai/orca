import * as monaco from 'monaco-editor'
import { vi } from 'vitest'
import { createEditorModelRegistry } from '@/lib/editor-model-registry'
import { createTestStore, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '@/store/slices/store-session-test-harness'
import type { OpenFile } from '@/store/slices/editor'
import { attachClosedEditorTabCleanup } from './closed-editor-tab-controller'
import { toEditorModelUri } from './editor-model-uri'
import {
  scrollTopCache,
  editorSelectionCache,
  diffViewStateCache,
  pdfViewPositionCache
} from '@/lib/scroll-cache'

const workspace = 'model-fixture::/fixture/workspace'
const models: monaco.editor.ITextModel[] = []
const disposers: (() => void)[] = []

export function createModelLifetimeFixture(register = true) {
  const domWindow = globalThis.window
  const api = createStoreSessionMockApi()
  Reflect.set(globalThis, 'window', domWindow)
  Reflect.set(domWindow, 'api', api)
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, id: 'model-fixture', path: '/fixture/workspace' }],
    worktreesByRepo: {
      'model-fixture': [
        makeWorktree({ id: workspace, repoId: 'model-fixture', path: '/fixture/workspace' })
      ]
    },
    activeWorktreeId: workspace
  })
  const bridge = createEditorModelRegistry()
  if (register) {
    disposers.push(bridge.register(monaco))
  }
  const attach = (): (() => void) => {
    const detach = attachClosedEditorTabCleanup(store, bridge)
    disposers.push(detach)
    return detach
  }
  const add = (id: string): { file: OpenFile; model: monaco.editor.ITextModel } => {
    const file = modelLifetimeFile(id)
    const model = modelLifetimeEditorModel(file.filePath, `${id}\n${'x'.repeat(256 * 1024)}`)
    store.setState({ openFiles: [...store.getState().openFiles, file], activeFileId: id })
    return { file, model }
  }
  return { store, bridge, attach, add }
}

export function modelLifetimeFile(id: string, mode: OpenFile['mode'] = 'edit'): OpenFile {
  return {
    id,
    worktreeId: workspace,
    filePath: `/fixture/workspace/${id}.txt`,
    relativePath: `${id}.txt`,
    mode,
    language: 'plaintext',
    isDirty: false
  }
}

export function modelLifetimeTextModel(
  modelUri: string,
  content = 'fixture'
): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(content, 'plaintext', monaco.Uri.parse(modelUri))
  models.push(model)
  return model
}

/** Mirrors how `MonacoEditor` names an edit-tab model, so disposal lookups resolve it. */
export function modelLifetimeEditorModel(
  filePath: string,
  content = 'fixture'
): monaco.editor.ITextModel {
  return modelLifetimeTextModel(toEditorModelUri(filePath), content)
}

type ModelAttachmentPort = {
  onBeforeAttached(): unknown
  onBeforeDetached(view: unknown): void
}

function hasModelAttachmentPort(
  model: monaco.editor.ITextModel
): model is monaco.editor.ITextModel & ModelAttachmentPort {
  return (
    'onBeforeAttached' in model &&
    typeof model.onBeforeAttached === 'function' &&
    'onBeforeDetached' in model &&
    typeof model.onBeforeDetached === 'function'
  )
}

export function attachModelLifetimeView(model: monaco.editor.ITextModel): () => void {
  // Exercise the installed model's real attachment event without constructing an editor widget.
  if (!hasModelAttachmentPort(model)) {
    throw new Error('Installed Monaco does not expose the expected attachment port')
  }
  const view = model.onBeforeAttached()
  return () => {
    model.onBeforeDetached(view)
  }
}

export function resetModelLifetimeFixtures(): void {
  while (disposers.length > 0) {
    disposers.pop()?.()
  }
  for (const model of models.splice(0)) {
    if (!model.isDisposed()) {
      model.dispose()
    }
  }
  scrollTopCache.clear()
  editorSelectionCache.clear()
  diffViewStateCache.clear()
  pdfViewPositionCache.clear()
  vi.restoreAllMocks()
}
