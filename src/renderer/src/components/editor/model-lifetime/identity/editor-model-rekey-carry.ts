import { useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { editorModelRegistry } from '@/lib/editor/monaco/editor-model-registry'
import { carryNewModelLineEndingState } from '../buffer-text/editor-new-model-line-ending'
import { takeRenamedEditorModelUri } from './editor-model-rename-handoff'

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
  const to = registry.editor.createModel(draft ?? from.getValue(), from.getLanguageId(), target)
  carryNewModelLineEndingState(from, to)
  return true
}

export function useEditorModelRekeyCarry(viewId: string, modelUri: string): void {
  const previous = useRef({ viewId, modelUri })
  // Run before the editor library’s passive effect creates the replacement model.
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = { viewId, modelUri }
    const registry = editorModelRegistry.get()
    // A rename remounts the editor under a new view id; its old model is handed off by the rename.
    // Only an unsaved draft continues the buffer; a clean tab reloads from disk as usual.
    const renamedFrom = takeRenamedEditorModelUri(viewId)
    const renamedDraft = renamedFrom ? useAppStore.getState().editorDrafts[viewId] : undefined
    if (renamedFrom && renamedDraft !== undefined && renamedFrom !== modelUri && registry) {
      carryEditorModelText(registry, renamedFrom, modelUri, renamedDraft)
      return
    }
    // Carry only within one view; reused mounts must not transfer text between files.
    if (from.viewId === viewId && from.modelUri !== modelUri && registry) {
      const draft = useAppStore.getState().editorDrafts[viewId]
      carryEditorModelText(registry, from.modelUri, modelUri, draft)
    }
  }, [viewId, modelUri])
}
