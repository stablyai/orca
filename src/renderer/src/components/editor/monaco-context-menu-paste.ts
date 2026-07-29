import type { editor } from 'monaco-editor'
import type { ReadClipboardTextOptions } from '../../../../shared/clipboard-text'
import { measureTextControlPasteByteLength } from '@/lib/text-control-paste'
import {
  MONACO_PASTE_DIRECT_MAX_BYTES,
  MONACO_PASTE_MAX_BYTES,
  type MonacoPasteEditor,
  executeMonacoLargeTextPaste
} from './monaco-large-text-paste'

// Why: Monaco's built-in context-menu Paste action (editor.action.clipboardPasteAction)
// reads the clipboard with navigator.clipboard.readText(). Orca runs the renderer with
// `sandbox: true`, where that read is blocked/empty — so right-click Paste silently does
// nothing even though Cmd+V (a real OS paste ClipboardEvent) and right-click Copy
// (execCommand('copy') from a user gesture) both work. We route the read through Orca's
// trusted clipboard IPC bridge instead, matching how the terminal already reads it.
export const ORCA_CONTEXT_MENU_PASTE_PRIORITY = 10001
export const ORCA_CONTEXT_MENU_PASTE_NAME = 'orca-ipc-paste'

// Why: this path may either dispatch a native paste (needs getOption/trigger)
// or hand off to the chunked inserter (needs the MonacoPasteEditor surface), so
// compose both. Both are satisfied by the real ICodeEditor.
type PasteCapableEditor = MonacoPasteEditor &
  Pick<editor.ICodeEditor, 'getModel' | 'hasTextFocus' | 'getOption' | 'trigger'>

// Mirrors the in-memory metadata Monaco stores at copy time so an in-app
// copy/paste round trip preserves empty-selection and multi-cursor behavior.
type ClipboardPasteMetadata = {
  isFromEmptySelection?: boolean
  multicursorText?: string[] | null
  mode?: string | null
} | null

export type OrcaContextMenuPasteDeps = {
  getFocusedEditor: () => PasteCapableEditor | null
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  getClipboardMetadata: (text: string) => ClipboardPasteMetadata
  emptySelectionClipboardOptionId: editor.EditorOption
  readOnlyOptionId: editor.EditorOption
  onTooLarge?: () => void
  onReadError?: (error: unknown) => void
}

export type OrcaContextMenuPasteOutcome =
  | { status: 'pasted'; mode: 'native' | 'chunked' }
  | { status: 'noop'; reason: 'empty' | 'read-failed' | 'too-large' | 'target-lost' }

function resolvePasteMetadata(
  editorInstance: PasteCapableEditor,
  metadata: ClipboardPasteMetadata,
  emptySelectionClipboardOptionId: editor.EditorOption
): { pasteOnNewLine: boolean; multicursorText: string[] | null; mode: string | null } {
  if (!metadata) {
    return { pasteOnNewLine: false, multicursorText: null, mode: null }
  }
  // Why: pasteOnNewLine only applies when the user copied a whole line with no
  // selection AND has empty-selection-clipboard enabled — same gate Monaco's
  // own paste handlers use.
  const emptySelectionClipboard = Boolean(editorInstance.getOption(emptySelectionClipboardOptionId))
  return {
    pasteOnNewLine: emptySelectionClipboard && metadata.isFromEmptySelection === true,
    multicursorText:
      typeof metadata.multicursorText !== 'undefined' ? (metadata.multicursorText ?? null) : null,
    mode: metadata.mode ?? null
  }
}

/**
 * Replacement implementation for Monaco's clipboard paste command. Returns
 * `false` when it declines to handle the paste so Monaco's default
 * implementation runs unchanged (read-only editor, no focus, no clipboard
 * bridge); otherwise performs the paste through Orca's IPC clipboard read and
 * returns a Promise (truthy) so Monaco's blocked default never runs.
 */
export function runOrcaContextMenuPaste(
  deps: OrcaContextMenuPasteDeps
): false | Promise<OrcaContextMenuPasteOutcome> {
  const editorInstance = deps.getFocusedEditor()
  // Why: only claim the paste when an editor truly has text focus and a model —
  // otherwise fall through so Monaco's default (and any other surface) behaves
  // exactly as before.
  if (!editorInstance || !editorInstance.getModel() || !editorInstance.hasTextFocus()) {
    return false
  }
  // Why: read-only editors (e.g. the unchanged side of a diff) must not accept
  // paste. The context menu hides the item via `when: writable`, but Cmd+V and
  // the command palette still reach this command, so guard explicitly.
  if (editorInstance.getOption(deps.readOnlyOptionId)) {
    return false
  }

  return performOrcaContextMenuPaste(editorInstance, deps)
}

async function performOrcaContextMenuPaste(
  editorInstance: PasteCapableEditor,
  deps: OrcaContextMenuPasteDeps
): Promise<OrcaContextMenuPasteOutcome> {
  let text: string
  try {
    text = await deps.readClipboardText({ maxBytes: MONACO_PASTE_MAX_BYTES })
  } catch (error) {
    // Why: the IPC bridge rejects clipboard text over the safe limit. Surface
    // the same too-large feedback the DOM-event paste path gives instead of
    // pasting a truncated payload.
    deps.onReadError?.(error)
    return { status: 'noop', reason: 'read-failed' }
  }
  if (!text) {
    return { status: 'noop', reason: 'empty' }
  }

  // Why: keep parity with the native Cmd+V paste, which routes oversized text
  // through the chunked inserter (and rejects beyond the hard cap) so a huge
  // right-click paste cannot freeze the renderer or bypass the size guard.
  const directMeasurement = measureTextControlPasteByteLength(text, {
    stopAfterBytes: MONACO_PASTE_DIRECT_MAX_BYTES
  })
  if (directMeasurement.exceededLimit) {
    const result = await executeMonacoLargeTextPaste(editorInstance, text, { readOnly: false })
    if (result.status === 'rejected' && result.reason === 'too-large') {
      deps.onTooLarge?.()
      return { status: 'noop', reason: 'too-large' }
    }
    if (result.status !== 'pasted') {
      return { status: 'noop', reason: 'target-lost' }
    }
    return { status: 'pasted', mode: 'chunked' }
  }

  if (!editorInstance.hasTextFocus()) {
    // Why: the await above yields to the event loop; if focus left the editor
    // meanwhile, dispatching paste would land in the wrong place.
    return { status: 'noop', reason: 'target-lost' }
  }

  const metadata = deps.getClipboardMetadata(text)
  const { pasteOnNewLine, multicursorText, mode } = resolvePasteMetadata(
    editorInstance,
    metadata,
    deps.emptySelectionClipboardOptionId
  )
  // Why: this is exactly how Monaco dispatches a paste internally — it respects
  // the current selection, multi-cursor, indentation, and undo grouping.
  editorInstance.trigger('keyboard', 'paste', { text, pasteOnNewLine, multicursorText, mode })
  return { status: 'pasted', mode: 'native' }
}
