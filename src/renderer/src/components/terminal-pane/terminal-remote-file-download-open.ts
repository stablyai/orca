import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { basename } from '@/lib/path'
import { downloadRuntimeFile } from '@/runtime/runtime-file-read-client'
import { downloadGrantedRuntimeFile } from '@/runtime/runtime-remote-file-download'
import { hostStreamsGrantedFiles } from '@/runtime/runtime-terminal-artifact-grant'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'

/**
 * Remote counterpart of "Open with default app": the OS can only launch a local
 * file, so the workspace copy is downloaded to a user-chosen path first.
 * False, before any download, for a granted file this client or its host cannot page; it opens in Orca instead.
 */
export async function downloadAndOpenRemoteTerminalFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string,
  grant?: { terminalArtifactGrantId: string } | null
): Promise<boolean> {
  const name = basename(filePath) || filePath
  const { target, worktreeId } = fileContext
  let granted: Parameters<typeof downloadGrantedRuntimeFile>[0] | null = null
  if (grant) {
    if (
      // Why: a paired web client has no local file to stream into.
      isPairedWebClientWindow() ||
      target.kind !== 'environment' ||
      !worktreeId ||
      !(await hostStreamsGrantedFiles(target.environmentId))
    ) {
      return false
    }
    granted = { target, worktreeId, absolutePath: filePath, grantId: grant.terminalArtifactGrantId }
  }
  try {
    const result = fileContext.connectionId
      ? await window.api.fs.downloadFile({ filePath, connectionId: fileContext.connectionId })
      : granted
        ? await downloadGrantedRuntimeFile(granted, name)
        : await downloadRuntimeFile(fileContext, filePath, name)
    // Why: cancelling the native save dialog is a deliberate no-op, not a failure.
    if (!result.canceled) {
      await window.api.shell.openFilePath(result.destinationPath, LOCAL_EXECUTION_HOST_ID)
    }
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.downloadOpenFailed',
          "Failed to download '{{value0}}'.",
          { value0: name }
        )
      )
    )
  }
  return true
}
