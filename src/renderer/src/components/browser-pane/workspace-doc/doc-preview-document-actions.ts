import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { isTwinWorkspace } from '@/lib/resolve-owner'
import { detectLanguage } from '@/lib/language-detect'
import {
  buildWorkspaceFileContextForFile,
  canClientOsOpenWorkspaceFile
} from '@/lib/workspace-file-host-routing'
import { useAppStore } from '@/store'
import { downloadAndOpenRemoteTerminalFile } from '@/components/terminal-pane/terminal-remote-file-download-open'

export type DocPreviewDocument = {
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId: string | null
  /** Source-tab routing only today; any preview opener setting this must also pass expectedExternalSshTargetId to external-open reads. */
  externalSshTargetId: string | null
}

/** Open a separate source tab so the rendered preview stays in place. */
export function openDocPreviewSource(document: DocPreviewDocument): void {
  useAppStore.getState().openFile({
    filePath: document.filePath,
    relativePath: document.relativePath,
    worktreeId: document.worktreeId,
    // Detect the source language independently; the preview pins its own language to HTML.
    language: detectLanguage(document.filePath),
    runtimeEnvironmentId: document.runtimeEnvironmentId,
    ...(document.externalSshTargetId ? { externalSshTargetId: document.externalSshTargetId } : {}),
    mode: 'edit'
  })
}

/** Download remote documents before asking the client OS to open them. */
export function openDocPreviewExternally(document: DocPreviewDocument): void {
  const state = useAppStore.getState()
  const worktreeRoot = state.getKnownWorktreeById(document.worktreeId)?.path ?? null
  // Resolve per-file ownership: folder workspaces may span hosts, and unresolved workspace ownership could open a same-named local file.
  const connectionId = getConnectionIdForFileFromState(
    state,
    document.worktreeId,
    document.filePath
  )
  // Resolve the owner used by the grant; restored tabs may still carry null from before ownership was known.
  const runtimeEnvironmentId =
    runtimeEnvironmentIdOrLocalUnlessTwin(state, document.worktreeId) ??
    document.runtimeEnvironmentId
  const fileContext = buildWorkspaceFileContextForFile(
    document.worktreeId,
    worktreeRoot ?? '',
    document.filePath,
    runtimeEnvironmentId
  )
  // Prove local ownership before OS-open; the shared predicate alone treats unknown owners/roots and paths outside runtime roots as local.
  const ownedByThisMachine =
    connectionId === null &&
    runtimeEnvironmentId === null &&
    worktreeRoot !== null &&
    // Why: a twin reads as "no server", which is not proof this machine holds the file.
    !isTwinWorkspace(state, document.worktreeId)
  if (ownedByThisMachine && canClientOsOpenWorkspaceFile(fileContext)) {
    void window.api.shell.openFilePath(document.filePath, LOCAL_EXECUTION_HOST_ID)
    return
  }
  // Refuse unresolved ownership: the download fallback could otherwise read this machine’s unrelated same-named file after its remote owner disappears.
  if (connectionId == null && runtimeEnvironmentId === null) {
    toast.error(
      translate(
        'auto.components.editor.HtmlDocPreview.openExternallyUnknownHostError',
        "Can't open '{{value0}}': the host that owns it is no longer known.",
        { value0: document.relativePath }
      )
    )
    return
  }
  void downloadAndOpenRemoteTerminalFile(fileContext, document.filePath)
}
