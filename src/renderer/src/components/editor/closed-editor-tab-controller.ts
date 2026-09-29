import type { StoreApi } from 'zustand'
import type { editor } from 'monaco-editor'
import type { OpenFile } from '@/store/slices/editor'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import { disposeClosedEditorModels, type ClosedEditorTab } from './closed-editor-tab-disposal'
import type { MonacoModelRegistry, DisposableMonacoModel } from './diff-monaco-model-disposal'
import { toEditorModelUri } from './editor-model-uri'

type EditorStore = Pick<StoreApi<{ openFiles: OpenFile[] }>, 'getState' | 'subscribe'>
type RetainedModel = {
  files: Map<string, ClosedEditorTab>
  detach: { dispose(): void }
  dispose: { dispose(): void }
}

function ownerKey(file: ClosedEditorTab): string {
  return JSON.stringify([file.id, file.mode, file.filePath])
}

export function attachClosedEditorTabCleanup(
  store: EditorStore,
  bridge = editorModelRegistry
): () => void {
  let registry = bridge.get()
  let previousFiles = store.getState().openFiles
  const pendingFiles = new Map<string, ClosedEditorTab>()
  const candidateModels = new Set<editor.ITextModel>()
  const retainedModels = new Map<editor.ITextModel, RetainedModel>()
  let active = true
  let scheduled = false
  let generation = 0

  const releaseRetainedModel = (model: editor.ITextModel): void => {
    const retained = retainedModels.get(model)
    if (!retained) {
      return
    }
    retainedModels.delete(model)
    retained.detach.dispose()
    retained.dispose.dispose()
    retained.files.clear()
  }

  const clearPending = (): void => {
    generation += 1
    scheduled = false
    pendingFiles.clear()
    candidateModels.clear()
    for (const model of retainedModels.keys()) {
      releaseRetainedModel(model)
    }
  }

  const schedule = (): void => {
    if (!active || scheduled) {
      return
    }
    scheduled = true
    const queuedGeneration = generation
    queueMicrotask(() => {
      if (!active || generation !== queuedGeneration) {
        return
      }
      scheduled = false
      flush()
    })
  }

  const retainAttachedModel = (candidate: DisposableMonacoModel, file: ClosedEditorTab): void => {
    if (!registry) {
      return
    }
    // Not `toEditorModelUri`: this re-resolves a live model's own URI (diff models are not `file:`).
    const model = registry.editor.getModel(registry.Uri.parse(candidate.uri.toString()))
    if (!model || model !== candidate) {
      return
    }
    let retained = retainedModels.get(model)
    if (!retained) {
      retained = {
        files: new Map(),
        detach: model.onDidChangeAttached(schedule),
        dispose: model.onWillDispose(() => releaseRetainedModel(model))
      }
      retainedModels.set(model, retained)
    }
    retained.files.set(ownerKey(file), file)
  }

  const flush = (): void => {
    const currentRegistry = registry
    if (!currentRegistry) {
      if (candidateModels.size === 0) {
        pendingFiles.clear()
      }
      return
    }
    const flushGeneration = generation
    let checkedOpenFiles: OpenFile[] | null = null
    let openIds = new Set<string>()
    let openEditUris = new Set<string>()
    const stillOwned = (file: ClosedEditorTab): boolean => {
      const openFiles = store.getState().openFiles
      if (openFiles !== checkedOpenFiles) {
        checkedOpenFiles = openFiles
        openIds = new Set(openFiles.map((openFile) => openFile.id))
        openEditUris = new Set(
          openFiles
            .filter((openFile) => openFile.mode === 'edit')
            .map((openFile) => toEditorModelUri(openFile.filePath))
        )
      }
      return (
        openIds.has(file.id) ||
        (file.mode === 'edit' && openEditUris.has(toEditorModelUri(file.filePath)))
      )
    }
    const disposeCaptured = (
      files: ClosedEditorTab[],
      models: ReadonlySet<editor.ITextModel>
    ): void => {
      if (!currentRegistry) {
        return
      }
      const fencedRegistry: MonacoModelRegistry = {
        Uri: currentRegistry.Uri,
        editor: {
          getModel(uri) {
            if (!currentRegistry.Uri.isUri(uri)) {
              return null
            }
            const model = currentRegistry.editor.getModel(uri)
            return model && models.has(model) ? model : null
          },
          getModels: () =>
            [...models].filter((model) => currentRegistry.editor.getModel(model.uri) === model)
        }
      }
      disposeClosedEditorModels(
        fencedRegistry,
        files,
        retainAttachedModel,
        (file) => active && generation === flushGeneration && !stillOwned(file)
      )
    }

    const files = [...pendingFiles.values()].filter((file) => !stillOwned(file))
    const models = new Set(candidateModels)
    pendingFiles.clear()
    candidateModels.clear()
    disposeCaptured(files, models)
    if (active && generation !== flushGeneration) {
      for (const file of files) {
        pendingFiles.set(ownerKey(file), file)
      }
      for (const model of models) {
        if (!model.isDisposed()) {
          candidateModels.add(model)
        }
      }
      schedule()
      return
    }

    for (const [model, retained] of retainedModels) {
      if (!active || generation !== flushGeneration) {
        return
      }
      if (currentRegistry?.editor.getModel(model.uri) !== model) {
        releaseRetainedModel(model)
        continue
      }
      const closedFiles = [...retained.files.values()].filter((file) => !stillOwned(file))
      if (closedFiles.length === 0) {
        releaseRetainedModel(model)
      } else if (!model.isAttachedToEditor()) {
        releaseRetainedModel(model)
        disposeCaptured(closedFiles, new Set([model]))
      }
    }
  }

  const unsubscribe = store.subscribe(() => {
    const openFiles = store.getState().openFiles
    if (openFiles === previousFiles) {
      return
    }
    const previous = previousFiles
    previousFiles = openFiles
    const liveIds = new Set(openFiles.map((file) => file.id))
    let removed = false
    let removedDiff = false
    for (const file of previous) {
      if (!liveIds.has(file.id)) {
        const descriptor = { id: file.id, mode: file.mode, filePath: file.filePath }
        pendingFiles.set(ownerKey(descriptor), descriptor)
        removed = true
        if (file.mode === 'edit' && registry) {
          const model = registry.editor.getModel(
            registry.Uri.parse(toEditorModelUri(file.filePath))
          )
          if (model) {
            candidateModels.add(model)
          }
        } else if (file.mode === 'diff') {
          removedDiff = true
        }
      }
    }
    if (removedDiff && registry) {
      for (const model of registry.editor.getModels()) {
        candidateModels.add(model)
      }
    }
    if (removed || retainedModels.size > 0) {
      schedule()
    }
  })
  const unsubscribeRegistry = bridge.subscribe(() => {
    // Registry notifications invalidate callbacks, not custody of captured models.
    generation += 1
    scheduled = false
    registry = bridge.get()
    if (pendingFiles.size > 0 || retainedModels.size > 0) {
      schedule()
    }
  })
  return () => {
    active = false
    unsubscribe()
    unsubscribeRegistry()
    clearPending()
  }
}
