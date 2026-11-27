import type { editor } from 'monaco-editor'
import type { RefObject } from 'react'
import { syncContentOnMount } from '../../model-lifetime/buffer-text/monaco-content-sync'

// Read-only tabs refuse drafts, so their Changes typing lives only in the kept model, never in the props.
const lastShownModifiedContent = new WeakMap<editor.ITextModel, string>()

/** Monaco keeps a leading BOM out of model text, so comparing with it would make every mount look stale. */
function withoutBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

/** Kept models are reused without @monaco-editor/react's initial value sync, so a remount would show stale text. */
export function syncKeptDiffModelsOnMount(
  diffEditor: editor.IStandaloneDiffEditor,
  contentRef: RefObject<{ originalContent: string; modifiedContent: string }>
): void {
  const { originalContent, modifiedContent } = contentRef.current
  // setValue is several times cheaper than a full-range edit, and stale undo entries would corrupt the file.
  syncContentOnMount(diffEditor.getOriginalEditor(), withoutBom(originalContent), 'reset-history')
  const modifiedEditor = diffEditor.getModifiedEditor()
  let modifiedModel = modifiedEditor.getModel()
  // Same text as last time: any difference is unsaved Changes typing, which a reset would discard.
  if (!modifiedModel || lastShownModifiedContent.get(modifiedModel) !== modifiedContent) {
    syncContentOnMount(modifiedEditor, withoutBom(modifiedContent), 'reset-history')
  }
  modifiedEditor.onDidChangeModel(() => {
    // The swapped-out model's last text is unknown here, so its next mount compares in full.
    if (modifiedModel) {
      lastShownModifiedContent.delete(modifiedModel)
    }
    modifiedModel = modifiedEditor.getModel()
  })
  modifiedEditor.onDidDispose(() => {
    if (modifiedModel) {
      lastShownModifiedContent.set(modifiedModel, contentRef.current.modifiedContent)
    }
  })
}
