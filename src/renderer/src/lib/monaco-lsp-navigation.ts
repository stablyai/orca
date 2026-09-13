import type * as monacoTypes from 'monaco-editor'
import type { LspDocumentContext } from '../../../shared/lsp-types'
import { getRelativePathInsideRoot, joinPath } from './path'
import { detectLanguage } from './language-detect'

export function resolveLspNavigationPath(
  resource: Pick<monacoTypes.Uri, 'scheme' | 'authority' | 'path'>,
  rootPath: string
): { filePath: string; relativePath: string } | null {
  if (resource.scheme !== 'file') {
    return null
  }
  const windowsRoot = /^[A-Za-z]:[\\/]/.test(rootPath) || /^[\\/]{2}/.test(rootPath)
  let filePath = resource.path
  if (resource.authority) {
    if (!windowsRoot) {
      return null
    }
    filePath = `//${resource.authority}${filePath}`
  } else if (windowsRoot && /^\/[A-Za-z]:\//.test(filePath)) {
    filePath = filePath.slice(1)
  }
  // Why: a language server can return dependency URIs outside the authorized workspace.
  if (filePath.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
    return null
  }
  const relativePath = getRelativePathInsideRoot(filePath, rootPath)
  return relativePath ? { filePath: joinPath(rootPath, relativePath), relativePath } : null
}

export function registerLspEditorOpener(
  monaco: typeof monacoTypes,
  contextForModel: (model: monacoTypes.editor.ITextModel) => LspDocumentContext | undefined
): monacoTypes.IDisposable {
  return monaco.editor.registerEditorOpener({
    async openCodeEditor(source, resource, selection) {
      const model = source.getModel()
      const context = model && contextForModel(model)
      if (!context) {
        return false
      }
      const target = resolveLspNavigationPath(resource, context.worktreePath)
      if (!target) {
        return false
      }
      const { useAppStore } = await import('@/store')
      const state = useAppStore.getState()
      state.openFile(
        {
          ...target,
          worktreeId: context.worktreeId,
          runtimeEnvironmentId: context.runtimeEnvironmentId ?? null,
          language: detectLanguage(target.filePath),
          mode: 'edit'
        },
        { preview: true, suppressActiveRuntimeFallback: true }
      )
      if (selection) {
        const range = 'startLineNumber' in selection
        const file = useAppStore
          .getState()
          .openFiles.find(
            (entry) => entry.filePath === target.filePath && entry.worktreeId === context.worktreeId
          )
        useAppStore.getState().setPendingEditorReveal({
          fileId: file?.id,
          filePath: target.filePath,
          line: range ? selection.startLineNumber : selection.lineNumber,
          column: range ? selection.startColumn : selection.column,
          matchLength:
            range && selection.startLineNumber === selection.endLineNumber
              ? selection.endColumn - selection.startColumn
              : 0
        })
      }
      return true
    }
  })
}
