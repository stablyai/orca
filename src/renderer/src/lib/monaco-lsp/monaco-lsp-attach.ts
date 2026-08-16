import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import { closeLspDocumentForModel, openLspDocumentForModel } from './monaco-lsp-documents'
import { clearLspMarkers, ensureLspSupportForLanguage } from './monaco-lsp-providers'

/** Open `model` as an LSP document and lazily register the language's
 *  providers; returns the detach cleanup. Shared by the file editor and the
 *  diff viewer's modified pane. */
export function attachMonacoLspDocument(params: {
  model: editor.ITextModel
  filePath: string
  rootPath: string
  worktreeId: string
  languageId: string
}): () => void {
  const modelUri = params.model.uri.toString()
  const clear = (staleModel: editor.ITextModel): void => clearLspMarkers(monaco, staleModel)
  let closed = false
  let opened = false
  void openLspDocumentForModel({
    model: params.model,
    filePath: params.filePath,
    rootPath: params.rootPath,
    worktreeId: params.worktreeId,
    languageId: params.languageId
  }).then((entry) => {
    if (!entry) {
      return
    }
    if (closed) {
      // Why: the surface unmounted while the open round-trip was in flight.
      closeLspDocumentForModel(modelUri, clear)
      return
    }
    opened = true
    ensureLspSupportForLanguage(monaco, params.languageId)
  })
  return () => {
    closed = true
    if (opened) {
      closeLspDocumentForModel(modelUri, clear)
    }
  }
}
