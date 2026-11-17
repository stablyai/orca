import type { editor } from 'monaco-editor'

export type MonacoContentSyncMode = 'undoable' | 'read-only-live-tail'

export function normalizeToModelEol(
  content: string,
  model: editor.ITextModel,
  currentContent: string
): string {
  const eol = model.getEOL()
  // Compare normalized EOLs because Monaco cannot retain the filesystem’s raw line endings.
  if ((eol === '\n' && !content.includes('\r')) || content === currentContent) {
    return content
  }
  const separators = eol === '\r\n' ? /\r(?!\n)|(?<!\r)\n/g : /\r\n|\r|\n/g
  return content.replace(separators, eol)
}

/** A model without line breaks takes the ending of incoming text that has them, as a fresh load would. */
function adoptIncomingLineEnding(model: editor.ITextModel, content: string): void {
  const firstBreak = content.search(/\r\n|\n|\r/)
  if (firstBreak === -1 || model.getLineCount() > 1) {
    return
  }
  const eol = content.startsWith('\r\n', firstBreak) ? '\r\n' : '\n'
  if (model.getEOL() !== eol) {
    // Literal EndOfLineSequence values (LF = 0, CRLF = 1) keep this free of the Monaco runtime.
    model.setEOL(eol === '\r\n' ? 1 : 0)
  }
}

function applyModelEdit(
  editorInstance: editor.IStandaloneCodeEditor,
  model: editor.ITextModel,
  edit: editor.IIdentifiedSingleEditOperation,
  mode: MonacoContentSyncMode,
  withUndoStops: boolean
): void {
  if (mode === 'read-only-live-tail') {
    // Machine-owned live tails need no undo; recording them retains another growing log copy.
    model.applyEdits([edit])
    return
  }
  if (withUndoStops) {
    editorInstance.pushUndoStop()
  }
  model.pushEditOperations([], [edit], () => null)
  if (withUndoStops) {
    editorInstance.pushUndoStop()
  }
}

function replaceModelContent(
  editorInstance: editor.IStandaloneCodeEditor,
  model: editor.ITextModel,
  currentContent: string,
  content: string,
  mode: MonacoContentSyncMode,
  withUndoStops: boolean
): void {
  if (currentContent === content) {
    return
  }
  const fullRange = model.getFullModelRange()
  const viewState = mode === 'undoable' ? editorInstance.saveViewState() : null
  applyModelEdit(editorInstance, model, { range: fullRange, text: content }, mode, withUndoStops)
  if (viewState) {
    editorInstance.restoreViewState(viewState)
  }
}

/** Reconcile retained models on remount: the React wrapper skips its initial value sync, hiding intervening external writes. */
export function syncContentOnMount(
  editorInstance: editor.IStandaloneCodeEditor,
  content: string,
  mode: MonacoContentSyncMode = 'undoable',
  currentContentSnapshot?: string
): boolean {
  const model = editorInstance.getModel()
  if (!model) {
    return false
  }
  const modelContent = currentContentSnapshot ?? model.getValue()
  adoptIncomingLineEnding(model, content)
  const normalizedContent = normalizeToModelEol(content, model, modelContent)
  if (modelContent === normalizedContent) {
    return false
  }
  // Avoid an undo stop on mount that would let Undo restore pre-remount text.
  replaceModelContent(editorInstance, model, modelContent, normalizedContent, mode, false)
  return true
}

/** Sync mounted prop updates; callers filter their own emitted-content echoes first. */
export function syncContentUpdate(
  editorInstance: editor.IStandaloneCodeEditor,
  content: string,
  mode: MonacoContentSyncMode = 'undoable'
): void {
  const model = editorInstance.getModel()
  if (!model) {
    return
  }
  const currentContent = model.getValue()
  adoptIncomingLineEnding(model, content)
  const normalizedContent = normalizeToModelEol(content, model, currentContent)
  if (currentContent.length === normalizedContent.length) {
    replaceModelContent(editorInstance, model, currentContent, normalizedContent, mode, true)
    return
  }
  if (
    normalizedContent.length > currentContent.length &&
    normalizedContent.startsWith(currentContent)
  ) {
    // Append in place to preserve viewport, selection, find and tokenization state above the new text.
    const fullRange = model.getFullModelRange()
    applyModelEdit(
      editorInstance,
      model,
      {
        range: {
          startLineNumber: fullRange.endLineNumber,
          startColumn: fullRange.endColumn,
          endLineNumber: fullRange.endLineNumber,
          endColumn: fullRange.endColumn
        },
        text: normalizedContent.slice(currentContent.length)
      },
      mode,
      true
    )
    return
  }
  replaceModelContent(editorInstance, model, currentContent, normalizedContent, mode, true)
}
