import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
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
  /**
   * Only the source tab reads this today, because no path that opens a preview sets it. If one ever
   * does, `openDocPreviewExternally` needs it as `expectedExternalSshTargetId` on the file context —
   * without it the read is not checked against the target the tab claims.
   */
  externalSshTargetId: string | null
}

/**
 * Open the previewed document as an ordinary source tab. A second tab, not a mode switch: the
 * preview keeps its own id, so the reader can leave the rendered page where it was.
 */
export function openDocPreviewSource(document: DocPreviewDocument): void {
  useAppStore.getState().openFile({
    filePath: document.filePath,
    relativePath: document.relativePath,
    worktreeId: document.worktreeId,
    // Why not the preview tab's language: it is pinned to 'html' for the preview itself, and the
    // source tab needs the editor's own detection to pick a highlighter.
    language: detectLanguage(document.filePath),
    runtimeEnvironmentId: document.runtimeEnvironmentId,
    ...(document.externalSshTargetId ? { externalSshTargetId: document.externalSshTargetId } : {}),
    mode: 'edit'
  })
}

/**
 * Hand the document to the reader's own machine. A preview is almost always remote, and the OS
 * cannot launch a path it has no copy of — so a remote document is downloaded first, exactly as
 * the terminal's "Download & open with default app" does.
 */
export function openDocPreviewExternally(document: DocPreviewDocument): void {
  const state = useAppStore.getState()
  const worktreeRoot = state.getKnownWorktreeById(document.worktreeId)?.path ?? null
  // Why the per-file resolver: this is the same document the grant authorized, and that grant was
  // minted against the file's own owner. A folder workspace spanning hosts answers `undefined`
  // workspace-wide, which downstream reads as local — the OS would then be handed a remote
  // absolute path and either do nothing or open an unrelated file of the same name.
  const connectionId = getConnectionIdForFileFromState(
    state,
    document.worktreeId,
    document.filePath
  )
  // Why re-resolve the runtime owner rather than trust the tab's field: the grant this preview
  // renders through was minted against the worktree's owner at render time, and a tab opened or
  // restored before that owner was known still carries null — which reads as local.
  const runtimeEnvironmentId =
    getRuntimeEnvironmentIdForWorktree(state, document.worktreeId) ?? document.runtimeEnvironmentId
  const fileContext = buildWorkspaceFileContextForFile(
    document.worktreeId,
    worktreeRoot ?? '',
    document.filePath,
    runtimeEnvironmentId
  )
  // Why these conditions rather than the shared predicate alone: it reads an unresolved owner, an
  // unknown workspace root, and a runtime-owned path that sits outside that root as "local", and a
  // preview really reaches all three. Only a document proven to live on this machine goes to the
  // OS; a resolved remote owner downloads first, and no owner at all is refused below.
  const ownedByThisMachine =
    connectionId === null && runtimeEnvironmentId === null && worktreeRoot !== null
  if (ownedByThisMachine && canClientOsOpenWorkspaceFile(fileContext, document.filePath)) {
    void window.api.shell.openFilePath(document.filePath)
    return
  }
  // Why refuse instead of downloading: with neither owner resolved the download route reads the
  // absolute path on THIS machine, so a client that happens to hold a file of the same name would
  // get its contents back under the remote document's name. Reachable once an owner un-resolves
  // under a tab that already exists — the repo evicted, the SSH target removed.
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
