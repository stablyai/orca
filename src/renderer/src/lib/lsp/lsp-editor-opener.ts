// src/renderer/src/lib/lsp/lsp-editor-opener.ts
import type * as Monaco from 'monaco-editor'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { LSP_PEEK_SCHEME } from './lsp-location-models'
import type { OwningWorktree } from './lsp-owning-worktree'

function toLineColumn(value: Monaco.IRange | Monaco.IPosition | undefined): {
  line: number | null
  column: number | null
} {
  if (!value) {
    return { line: null, column: null }
  }
  if ('startLineNumber' in value) {
    return { line: value.startLineNumber, column: value.startColumn }
  }
  return { line: value.lineNumber, column: value.column }
}

export function registerLspEditorOpener(
  monaco: typeof Monaco,
  findOwner: (fsPath: string) => OwningWorktree | null
): Monaco.IDisposable {
  return monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file' && resource.scheme !== LSP_PEEK_SCHEME) {
        return false
      }
      if (resource.scheme === 'file' && source.getModel()?.uri.toString() === resource.toString()) {
        return false
      }
      const fsPath =
        resource.scheme === 'file' ? resource.fsPath : monaco.Uri.file(resource.path).fsPath
      const owner = findOwner(fsPath)
      if (!owner) {
        return false
      }
      const { line, column } = toLineColumn(selectionOrPosition)
      // Why: reuse the terminal path-open flow so tab reuse, reveal timing and failures behave identically.
      openDetectedFilePath(fsPath, line, column, {
        worktreeId: owner.worktreeId,
        worktreePath: owner.worktreePath
      })
      return true
    }
  })
}
