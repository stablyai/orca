import type { editor } from 'monaco-editor'
import type { ReadClipboardTextOptions } from '../../../../shared/clipboard-text'
import { measureTextControlPasteByteLength } from '@/lib/text-control-paste'
import {
  MONACO_PASTE_DIRECT_MAX_BYTES,
  MONACO_PASTE_MAX_BYTES,
  type MonacoPasteEditor,
  executeMonacoLargeTextPaste
} from './monaco-large-text-paste'

// Override Monaco’s sandbox-blocked clipboard read through trusted IPC, matching terminal paste.
export const ORCA_CONTEXT_MENU_PASTE_PRIORITY = 10001
export const ORCA_CONTEXT_MENU_PASTE_NAME = 'orca-ipc-paste'

type PasteCapableEditor = MonacoPasteEditor &
  Pick<editor.ICodeEditor, 'getModel' | 'hasTextFocus' | 'getOption' | 'trigger'>

// Match Monaco’s copy metadata to preserve whole-line and multicursor paste behavior.
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
  // Match Monaco’s whole-line paste gate: empty selection at copy time and empty-selection clipboard enabled.
  const emptySelectionClipboard = Boolean(editorInstance.getOption(emptySelectionClipboardOptionId))
  return {
    pasteOnNewLine: emptySelectionClipboard && metadata.isFromEmptySelection === true,
    multicursorText:
      metadata.multicursorText !== undefined ? (metadata.multicursorText ?? null) : null,
    mode: metadata.mode ?? null
  }
}

/** Return false to yield to Monaco; a truthy Promise claims IPC paste and prevents its blocked default from running. */
export function runOrcaContextMenuPaste(
  deps: OrcaContextMenuPasteDeps
): false | Promise<OrcaContextMenuPasteOutcome> {
  const editorInstance = deps.getFocusedEditor()
  // Claim only the focused text editor so other surfaces retain their paste behavior.
  if (!editorInstance || !editorInstance.getModel() || !editorInstance.hasTextFocus()) {
    return false
  }
  // Command-palette and keyboard paths bypass the context menu’s writable guard.
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
    // Report oversized/rejected IPC reads like DOM paste instead of inserting truncated text.
    deps.onReadError?.(error)
    return { status: 'noop', reason: 'read-failed' }
  }
  if (!text) {
    return { status: 'noop', reason: 'empty' }
  }

  // Share native paste size limits and chunking so context-menu paste cannot freeze the renderer or bypass the cap.
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
    // Clipboard IPC yields; do not paste into an editor that lost focus meanwhile.
    return { status: 'noop', reason: 'target-lost' }
  }

  const metadata = deps.getClipboardMetadata(text)
  const { pasteOnNewLine, multicursorText, mode } = resolvePasteMetadata(
    editorInstance,
    metadata,
    deps.emptySelectionClipboardOptionId
  )
  // Use Monaco’s paste command to preserve selection, multicursor, indentation and undo behavior.
  editorInstance.trigger('keyboard', 'paste', { text, pasteOnNewLine, multicursorText, mode })
  return { status: 'pasted', mode: 'native' }
}
