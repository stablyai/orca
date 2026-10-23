import type { OpenFile } from '../store/slices/editor'

/** The unsaved draft a restart checkpoint carries for this file, or undefined when it can't carry one.
 *  The restart owner and the session builder both decide with this, so they can't disagree. */
export function getBackedUpEditorDraft(
  file: OpenFile,
  editorDrafts: Record<string, string>
): string | undefined {
  // Why: never persist a dirty draft for a read-only tab — restoring one would reintroduce writable/hot-exit state for an agent transcript.
  return file.mode === 'edit' && file.readOnly !== true ? editorDrafts[file.id] : undefined
}
