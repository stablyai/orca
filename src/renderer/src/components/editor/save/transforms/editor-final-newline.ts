import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { editorModelRegistry } from '@/lib/editor/monaco/editor-model-registry'
import { editorTabModelUri } from '../queue/editor-save-disk-precondition'
import { hasPendingEditorBufferChange } from '../flush/editor-pending-flush'
import { normalizeToModelEol } from '../../model-lifetime/buffer-text/monaco-content-sync'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync
} from '../../model-lifetime/buffer-text/monaco-programmatic-sync'

export function needsFinalNewline(text: string): boolean {
  return text !== '' && !text.endsWith('\n') && !text.endsWith('\r')
}

function finalLineEnding(text: string, modelEol: string | undefined): '\n' | '\r\n' {
  const lastLf = text.lastIndexOf('\n')
  if (lastLf !== -1) {
    return text[lastLf - 1] === '\r' ? '\r\n' : '\n'
  }
  return modelEol === '\r\n' ? '\r\n' : '\n'
}

function isUniformLineEnding(text: string, eol: '\n' | '\r\n'): boolean {
  return eol === '\n' ? !text.includes('\r') : !/\r(?!\n)|(?<!\r)\n/.test(text)
}

export function insertFinalNewlineBeforeSave(
  state: AppState,
  file: OpenFile,
  content: string,
  buffered: string
): string {
  const needsNewline = needsFinalNewline(content)
  const draft = state.editorDrafts[file.id]
  const cleanTransformed =
    content !== buffered &&
    draft === undefined &&
    state.openFiles.find((openFile) => openFile.id === file.id)?.isDirty === false
  if (!needsNewline && !cleanTransformed) {
    return content
  }

  const registry = editorModelRegistry.get()
  const modelUri = editorTabModelUri(state, file)
  const model = registry?.editor.getModel(registry.Uri.parse(modelUri))
  const currentModel = model && !model.isDisposed() ? model.getValue() : undefined
  const eol = finalLineEnding(content, model?.isDisposed() ? undefined : model?.getEOL())
  const next = needsNewline ? `${content}${eol}` : content
  const divergedModel =
    model &&
    currentModel !== undefined &&
    normalizeToModelEol(content, model, currentModel) !== currentModel &&
    normalizeToModelEol(buffered, model, currentModel) !== currentModel
  if (
    (draft !== undefined && draft !== content) ||
    hasPendingEditorBufferChange(state, file.id) ||
    divergedModel
  ) {
    return next
  }

  if (registry && model && currentModel !== undefined) {
    const uniformEol = isUniformLineEnding(next, eol)
    const modelText = uniformEol ? next : normalizeToModelEol(next, model, currentModel)
    const modelEol = uniformEol ? eol : model.getEOL()
    const editors = registry.editor.getEditors().filter((editor) => editor.getModel() === model)
    const views = editors.map((editor) => ({
      editor,
      viewState: editor.saveViewState(),
      selections: editor.getSelections()
    }))
    const range = model.getFullModelRange()
    const append = modelText.startsWith(currentModel)
    const end = range.getEndPosition()
    beginProgrammaticContentSync(modelUri)
    try {
      model.pushStackElement()
      if (model.getEOL() !== modelEol) {
        model.pushEOL(
          modelEol === '\r\n'
            ? registry.editor.EndOfLineSequence.CRLF
            : registry.editor.EndOfLineSequence.LF
        )
      }
      model.pushEditOperations(
        [],
        [
          {
            range: append
              ? {
                  startLineNumber: end.lineNumber,
                  startColumn: end.column,
                  endLineNumber: end.lineNumber,
                  endColumn: end.column
                }
              : range,
            text: append ? modelText.slice(currentModel.length) : modelText
          }
        ],
        () => null
      )
      model.pushStackElement()
    } finally {
      endProgrammaticContentSync(modelUri)
    }
    for (const { editor, viewState, selections } of views) {
      if (viewState) {
        editor.restoreViewState(viewState)
      } else if (selections) {
        editor.setSelections(selections)
      }
    }
  }

  state.setEditorDraft(file.id, next)
  state.markFileDirty(file.id, true)
  return next
}
