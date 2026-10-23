import { useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { editorModelRegistry } from '@/lib/editor-model-registry'

type ModelRegistry = NonNullable<ReturnType<typeof editorModelRegistry.get>>

/**
 * A live view whose model URI changes (owner resolved, detach, rejoin) is a re-key, not a close:
 * the new model starts from the record's draft, else the old model's text. Why the draft first:
 * before a detach the old model holds the other record's text. Undo history does not carry, as on
 * rename. An existing model at the new URI is the record's own and wins. The closed-tab controller
 * disposes the old model once nothing shows it.
 */
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

/** Carries a view's text across a model URI change, before the editor remounts on it. */
export function useEditorModelRekeyCarry(viewId: string, modelUri: string): void {
  const previous = useRef({ viewId, modelUri })
  // Why a layout effect: it runs before the editor library creates the new model in its own effect.
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = { viewId, modelUri }
    const registry = editorModelRegistry.get()
    // Why the same view only: a mount reused for another tab must never carry one file into another.
    if (from.viewId === viewId && from.modelUri !== modelUri && registry) {
      const draft = useAppStore.getState().editorDrafts[viewId]
      carryEditorModelText(registry, from.modelUri, modelUri, draft)
    }
  }, [viewId, modelUri])
}
