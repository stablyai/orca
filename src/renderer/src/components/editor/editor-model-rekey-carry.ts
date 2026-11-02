import { useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { editorModelRegistry } from '@/lib/editor-model-registry'

type ModelRegistry = NonNullable<ReturnType<typeof editorModelRegistry.get>>

/** On rekey, seed from the record draft before old model text, which may belong to a pre-detach sibling. Existing destination models win; undo resets as on rename, and the close controller later disposes unused models. */
export function carryEditorModelText(
  registry: ModelRegistry,
  fromUri: string,
  toUri: string,
  draft: string | undefined
): boolean {
  const from = registry.editor.getModel(registry.Uri.parse(fromUri))
  const target = registry.Uri.parse(toUri)
  if (!from || from.isDisposed() || registry.editor.getModel(target)) {
    return false
  }
  registry.editor.createModel(draft ?? from.getValue(), from.getLanguageId(), target)
  return true
}

export function useEditorModelRekeyCarry(viewId: string, modelUri: string): void {
  const previous = useRef({ viewId, modelUri })
  // Run before the editor library’s passive effect creates the replacement model.
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = { viewId, modelUri }
    const registry = editorModelRegistry.get()
    // Carry only within one view; reused mounts must not transfer text between files.
    if (from.viewId === viewId && from.modelUri !== modelUri && registry) {
      const draft = useAppStore.getState().editorDrafts[viewId]
      carryEditorModelText(registry, from.modelUri, modelUri, draft)
    }
  }, [viewId, modelUri])
}
