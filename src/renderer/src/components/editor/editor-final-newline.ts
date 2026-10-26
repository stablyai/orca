import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { editorModelRegistry, type EditorModelRegistryBridge } from '@/lib/editor-model-registry'
import { editorTabModelUri, isCodeViewTab } from './editor-save-disk-precondition'

/** Empty text stays empty, matching VS Code's `files.insertFinalNewline`. */
export function withFinalNewline(text: string): string {
  if (text === '' || text.endsWith('\n') || text.endsWith('\r')) {
    return text
  }
  return `${text}${text.includes('\r\n') ? '\r\n' : '\n'}`
}

/** Returns the text to save; edits the code model like a user edit so undo, dirty state and cursors stay coherent. */
export function insertFinalNewlineBeforeSave(
  state: AppState,
  file: OpenFile,
  content: string,
  bridge: EditorModelRegistryBridge = editorModelRegistry
): string {
  // Why code views only: rich Markdown, notebook and CSV views serialize their own text.
  if (state.settings?.editorInsertFinalNewline !== true || !isCodeViewTab(state, file)) {
    return content
  }
  let next = withFinalNewline(content)
  if (next === content) {
    return content
  }
  const registry = bridge.get()
  const model = registry?.editor.getModel(registry.Uri.parse(editorTabModelUri(state, file)))
  const modelMatchesContent = Boolean(model && !model.isDisposed() && model.getValue() === content)
  if (registry && model && modelMatchesContent) {
    const editors = registry.editor.getEditors().filter((editor) => editor.getModel() === model)
    const selections = editors.map((editor) => editor.getSelections())
    const end = model.getFullModelRange().getEndPosition()
    model.pushStackElement()
    model.pushEOL(
      next.endsWith('\r\n')
        ? registry.editor.EndOfLineSequence.CRLF
        : registry.editor.EndOfLineSequence.LF
    )
    model.pushEditOperations(
      [],
      [
        {
          range: {
            startLineNumber: end.lineNumber,
            startColumn: end.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column
          },
          text: model.getEOL()
        }
      ],
      () => null
    )
    model.pushStackElement()
    // Why: a cursor at the end of the file would otherwise follow the newline onto the next line.
    editors.forEach((editor, index) => {
      const selection = selections[index]
      if (selection) {
        editor.setSelections(selection)
      }
    })
    next = model.getValue()
  }
  if (!model || model.isDisposed() || modelMatchesContent) {
    state.setEditorDraft(file.id, next)
  }
  return next
}
