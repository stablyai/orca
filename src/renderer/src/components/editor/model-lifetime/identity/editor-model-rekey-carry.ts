import { useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { editorModelRegistry } from '@/lib/editor/monaco/editor-model-registry'
import {
  applyBufferLineEnding,
  snapshotBufferLineEnding
} from '../buffer-text/existing-file-line-ending'
import { takeRenamedBufferLineEnding } from './editor-model-rename-handoff'

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
  applyBufferLineEnding(to, snapshotBufferLineEnding(from))
  return true
}

export function useEditorModelRekeyCarry(viewId: string, modelUri: string): void {
  const previous = useRef({ viewId, modelUri })
  // Run before the editor library’s passive effect creates the replacement model.
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = { viewId, modelUri }
    const registry = editorModelRegistry.get()
    // A rename remounts the editor under a new view id; the rename left its unsaved buffer's ending.
    const renamed = takeRenamedBufferLineEnding(viewId)
    const renamedDraft = renamed ? useAppStore.getState().editorDrafts[viewId] : undefined
    if (renamed && renamedDraft !== undefined && registry) {
      const target = registry.Uri.parse(modelUri)
      // An existing model at the destination is the file's own; only a model built here takes it.
      if (!registry.editor.getModel(target)) {
        // Language is left to the editor, which applies the file's language on mount.
        applyBufferLineEnding(registry.editor.createModel(renamedDraft, undefined, target), renamed)
      }
      return
    }
    // Carry only within one view; reused mounts must not transfer text between files.
    if (from.viewId === viewId && from.modelUri !== modelUri && registry) {
      const draft = useAppStore.getState().editorDrafts[viewId]
      carryEditorModelText(registry, from.modelUri, modelUri, draft)
    }
  }, [viewId, modelUri])
}
