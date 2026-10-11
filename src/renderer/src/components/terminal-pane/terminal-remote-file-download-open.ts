import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { basename } from '@/lib/path'
import { downloadRuntimeFile, type RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { runRemoteDownloadWithProgress } from '@/components/transfer-progress/download-progress-panel'

/**
 * Remote counterpart of "Open with default app": the OS can only launch a local
 * file, so the workspace copy is downloaded to a user-chosen path first.
 */
export async function downloadAndOpenRemoteTerminalFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string
): Promise<void> {
  const name = basename(filePath) || filePath
  try {
    // Why: SSH workspaces are served by the host's runtime; downloadRuntimeFile still falls
    // back to the SSH connection for a context with no runtime owner.
    const result = await runRemoteDownloadWithProgress(name, (transfer) =>
      downloadRuntimeFile(fileContext, filePath, name, transfer)
    )
    // Why: cancelling the native save dialog is a deliberate no-op, not a failure.
    if (result.canceled) {
      return
    }
    await window.api.shell.openFilePath(result.destinationPath, LOCAL_EXECUTION_HOST_ID)
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
}
