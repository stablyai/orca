import { useEffect } from 'react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { findIndexedWorktreeOwnerForHost } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { isCopilotAttachOwnerLocal } from '@/lib/monaco-copilot/copilot-attach-owner'
import { attachMonacoCopilotDocument } from '@/lib/monaco-copilot/monaco-copilot-attach'
import { useCopilotStatus } from '@/lib/monaco-copilot/copilot-status'
import { selectFolderWorkspaceOnHost } from '@/store/folder-workspaces/folder-workspace-record-index'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

/** Attach an editable local file to GitHub Copilot for ghost text. Inert unless
 *  copilot-language-server is installed and signed in; SSH and remote-runtime
 *  workspaces never attach, since their paths belong to another machine. */
export function useMonacoCopilot(params: {
  mountedEditor: editor.IStandaloneCodeEditor | null
  fileId: string
  filePath: string
  language: string
  worktreeId: string | undefined
  readOnly: boolean
  liveTail: boolean
}): void {
  const { mountedEditor, fileId, filePath, language, worktreeId, readOnly, liveTail } = params
  const rootPath = useAppStore((s) => {
    if (!worktreeId) {
      return null
    }
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      return (
        selectFolderWorkspaceOnHost(s, scope.folderWorkspaceId, LOCAL_EXECUTION_HOST_ID)
          ?.folderPath ?? null
      )
    }
    return (
      findIndexedWorktreeOwnerForHost(selectWorktreesByRepo(s), worktreeId, LOCAL_EXECUTION_HOST_ID)
        ?.path ?? null
    )
  })
  const ownerLocal = useAppStore((s) =>
    isCopilotAttachOwnerLocal(s, { fileId, filePath, worktreeId: worktreeId ?? null })
  )
  const copilotStatus = useCopilotStatus()
  const installed = copilotStatus !== null
  // Why: signing in or out re-attaches open editors, so ghost text starts or stops without a reload.
  const copilotUser = copilotStatus?.user ?? null

  useEffect(() => {
    if (
      !mountedEditor ||
      !worktreeId ||
      !rootPath ||
      !installed ||
      !ownerLocal ||
      readOnly ||
      liveTail
    ) {
      return
    }
    const model = mountedEditor.getModel()
    if (!model || model.isDisposed()) {
      return
    }
    return attachMonacoCopilotDocument({ model, filePath, rootPath, languageId: language })
  }, [
    mountedEditor,
    filePath,
    language,
    worktreeId,
    rootPath,
    installed,
    copilotUser,
    ownerLocal,
    readOnly,
    liveTail
  ])
}
