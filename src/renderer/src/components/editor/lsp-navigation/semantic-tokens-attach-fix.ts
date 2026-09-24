// S5 / spike findings §1 GATE 2 (attach): monaco NEVER fetches semantic tokens
// for a model not attached to an editor (`_fetchDocumentSemanticTokensNow`
// returns early, no retry). @monaco-editor/react creates the editor async; if
// openFile/setModel runs before the instance is ready (optional chaining
// silently skips), the model never attaches -> no color. The fix: re-setModel
// on the active path inside the editor onMount callback.
//
// Isolated as a pure seam so the wiring is unit-testable without a live editor.
import type * as Monaco from 'monaco-editor'
import { toEditorModelUri } from '../editor-model-uri'

/**
 * Re-attaches the active file model to the editor. Called from onMount so the
 * model is guaranteed attached to the live editor instance, letting monaco's
 * semantic-tokens contrib fetch for it. Idempotent (no-op when the model is
 * already attached or absent from the registry).
 */
export function reattachActiveModelForSemanticTokens(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  filePath: string
): void {
  const uri = monaco.Uri.parse(toEditorModelUri(filePath))
  const model = monaco.editor.getModel(uri)
  if (!model) {
    // No model in the registry yet (e.g. non-file model) — nothing to attach.
    return
  }
  // setModel is idempotent: re-setting the already-attached model still
  // triggers the attach path the contrib listens on.
  editor.setModel(model)
}
