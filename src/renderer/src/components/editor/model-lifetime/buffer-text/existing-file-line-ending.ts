import type { editor } from 'monaco-editor'
import type { EditorLineEnding } from '../../../../../../shared/editor/saving/editor-end-of-line'

type EolModel = Pick<editor.ITextModel, 'getEOL'>

// Models that held line breaks the user did not type (loaded or written in); their ending is the file's.
// Why per model: retained models outlive editor mounts and are shared by split panes.
const existingFileModels = new WeakMap<EolModel, true>()

export function isExistingFileModel(model: EolModel): boolean {
  return existingFileModels.has(model)
}

export function markExistingFileModel(model: EolModel): void {
  existingFileModels.set(model, true)
}

/** What a buffer's replacement model must keep: its ending and existing-file status. */
export type BufferLineEndingSnapshot = { eol: EditorLineEnding; existingFile: boolean }

export function snapshotBufferLineEnding(model: EolModel): BufferLineEndingSnapshot {
  return {
    eol: model.getEOL() === '\r\n' ? '\r\n' : '\n',
    existingFile: existingFileModels.has(model)
  }
}

/** Applies a snapshot to a freshly created replacement model for the same buffer. */
export function applyBufferLineEnding(
  model: Pick<editor.ITextModel, 'getLineCount' | 'getEOL' | 'setEOL'>,
  snapshot: BufferLineEndingSnapshot
): void {
  // Why one line only: a multi-line replacement already carries its text's ending.
  if (model.getLineCount() <= 1 && model.getEOL() !== snapshot.eol) {
    // Literal EndOfLineSequence values (LF = 0, CRLF = 1) keep this free of the Monaco runtime.
    model.setEOL(snapshot.eol === '\r\n' ? 1 : 0)
  }
  if (snapshot.existingFile) {
    existingFileModels.set(model, true)
  }
}
