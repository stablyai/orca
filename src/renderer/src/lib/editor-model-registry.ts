import type * as Monaco from 'monaco-editor'

type EditorModelRegistry = Pick<typeof Monaco, 'editor' | 'Uri'>

export type EditorModelRegistryBridge = {
  get(): EditorModelRegistry | null
  retainDiffModels(fileId: string, models: readonly Monaco.editor.ITextModel[]): void
  getRetainedDiffModels(fileId: string): readonly Monaco.editor.ITextModel[]
  getRetainedDiffModelOwners(model: Monaco.editor.ITextModel): readonly string[]
  subscribe(listener: () => void): () => void
  register(registry: EditorModelRegistry): () => void
}

export function createEditorModelRegistry(): EditorModelRegistryBridge {
  let registration: { registry: EditorModelRegistry } | null = null
  const listeners = new Set<() => void>()
  const diffModelsByFile = new Map<string, Set<Monaco.editor.ITextModel>>()
  const ownersByDiffModel = new WeakMap<Monaco.editor.ITextModel, Set<string>>()
  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    get: (): EditorModelRegistry | null => registration?.registry ?? null,
    retainDiffModels(fileId, models): void {
      for (const model of models) {
        if (model.isDisposed()) {
          continue
        }
        const ownedModels = diffModelsByFile.get(fileId) ?? new Set<Monaco.editor.ITextModel>()
        ownedModels.add(model)
        diffModelsByFile.set(fileId, ownedModels)
        const priorOwners = ownersByDiffModel.get(model)
        if (priorOwners) {
          priorOwners.add(fileId)
          continue
        }
        const owners = new Set([fileId])
        ownersByDiffModel.set(model, owners)
        const listener = model.onWillDispose(() => {
          for (const owner of owners) {
            const retained = diffModelsByFile.get(owner)
            retained?.delete(model)
            if (retained?.size === 0) {
              diffModelsByFile.delete(owner)
            }
          }
          ownersByDiffModel.delete(model)
          listener.dispose()
        })
      }
    },
    getRetainedDiffModels: (fileId) => [...(diffModelsByFile.get(fileId) ?? [])],
    getRetainedDiffModelOwners: (model) => [...(ownersByDiffModel.get(model) ?? [])],
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    register(registry: EditorModelRegistry): () => void {
      const next = { registry }
      registration = next
      notify()
      return () => {
        if (registration !== next) {
          return
        }
        registration = null
        notify()
      }
    }
  }
}

export const editorModelRegistry = createEditorModelRegistry()
