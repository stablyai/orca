import { useEffect } from 'react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getConnectionId } from '@/lib/connection-context'
import { attachMonacoLspDocument } from '@/lib/monaco-lsp/monaco-lsp-attach'
import { resolveAnnotationPathInsideWorktree } from './check-annotation-path'

/** Attach the modified pane of a diff to a local language server so hover,
 *  definitions, and diagnostics reflect real project types instead of the
 *  sandboxed single-file worker. The original (base) pane stays plain. */
export function useMonacoLspForDiff(params: {
  modifiedEditor: editor.ICodeEditor | null
  relativePath: string
  worktreeId: string | undefined
  language: string
  /** Changes whenever the diff's Monaco models are re-created. */
  modelIdentity: string
}): void {
  const { modifiedEditor, relativePath, worktreeId, language, modelIdentity } = params
  const worktreePath = useAppStore((s) =>
    worktreeId ? (findWorktreeById(s.worktreesByRepo, worktreeId)?.path ?? null) : null
  )

  useEffect(() => {
    if (!modifiedEditor || !worktreeId || !worktreePath) {
      return
    }
    if (getConnectionId(worktreeId) !== null) {
      return
    }
    const resolved = resolveAnnotationPathInsideWorktree(worktreePath, relativePath)
    if (!resolved) {
      return
    }
    const model = modifiedEditor.getModel()
    if (!model || model.isDisposed()) {
      return
    }
    return attachMonacoLspDocument({
      model,
      filePath: resolved.absolutePath,
      rootPath: worktreePath,
      worktreeId,
      languageId: language
    })
    // Why: modelIdentity re-attaches after the diff surface swaps its models.
  }, [modifiedEditor, worktreeId, worktreePath, relativePath, language, modelIdentity])
}
