import type * as Monaco from 'monaco-editor'

export type EditorModelRegistryBridge = {
  get(): typeof Monaco | null
  subscribe(listener: () => void): () => void
  register(registry: typeof Monaco): () => void
}

export function createEditorModelRegistry(): EditorModelRegistryBridge {
  let registration: { registry: typeof Monaco } | null = null
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    get: (): typeof Monaco | null => registration?.registry ?? null,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    register(registry: typeof Monaco): () => void {
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
