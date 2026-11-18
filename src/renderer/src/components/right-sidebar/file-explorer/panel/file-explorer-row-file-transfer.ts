import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { downloadRuntimeFile } from '@/runtime/files/reads/runtime-file-read-client'
import { showDownloadedFileToast } from '@/lib/files/download/downloaded-file-toast'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { TreeNode } from '../tree/file-explorer-types'
import { shouldShowCopyFileAction } from './file-explorer-row-action-visibility'

export async function downloadRemoteFile(
  node: TreeNode,
  connectionIdOrRuntimeContext: string | RuntimeFileOperationArgs
): Promise<void> {
  try {
    const result =
      typeof connectionIdOrRuntimeContext === 'string'
        ? await window.api.fs.downloadFile({
            filePath: node.path,
            connectionId: connectionIdOrRuntimeContext
          })
        : await downloadRuntimeFile(connectionIdOrRuntimeContext, node.path, node.name)
    if (result.canceled) {
      return
    }
    showDownloadedFileToast(result.destinationPath)
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate(
          'auto.components.right.sidebar.FileExplorerRow.b3e288bf41',
          "Failed to download '{{value0}}'.",
          { value0: node.name }
        )
      )
    )
  }
}

export async function copyFileToOsClipboard(
  node: TreeNode,
  connectionId?: string | null
): Promise<void> {
  const failureMessage = translate(
    'auto.components.right.sidebar.FileExplorerRow.b234ab25b4',
    'Could not copy the file to the clipboard'
  )
  if (!shouldShowCopyFileAction(node, connectionId)) {
    toast.error(failureMessage)
    return
  }
  const stagingFailureMessage = translate(
    'auto.components.right.sidebar.FileExplorerRow.clipboardStagingUnavailable',
    "Could not copy the file because Orca's temporary storage is unavailable"
  )
  try {
    const result = await window.api.ui.writeClipboardFile(
      connectionId ? { filePath: node.path, connectionId } : node.path
    )
    if (!result.ok) {
      toast.error(result.reason === 'staging-unavailable' ? stagingFailureMessage : failureMessage)
    }
  } catch (error) {
    toast.error(extractIpcErrorMessage(error, failureMessage))
  }
}
