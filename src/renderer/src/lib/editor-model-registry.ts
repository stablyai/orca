import type * as Monaco from 'monaco-editor'

type EditorModelRegistry = Pick<typeof Monaco, 'editor' | 'Uri'>

export type EditorModelRegistryBridge = {
  get(): EditorModelRegistry | null
  subscribe(listener: () => void): () => void
  register(registry: EditorModelRegistry): () => void
}

export function createEditorModelRegistry(): EditorModelRegistryBridge {
  let registration: { registry: EditorModelRegistry } | null = null
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    get: (): EditorModelRegistry | null => registration?.registry ?? null,
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
