import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { downloadRuntimeFile, type RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { TreeNode } from './file-explorer-types'

function getLocalDownloadName(destinationPath: string, platform: NodeJS.Platform): string {
  const lastSeparatorIndex =
    platform === 'win32'
      ? Math.max(destinationPath.lastIndexOf('/'), destinationPath.lastIndexOf('\\'))
      : destinationPath.lastIndexOf('/')
  return destinationPath.slice(lastSeparatorIndex + 1)
}

export async function downloadRemoteFile(
  node: TreeNode,
  connectionIdOrRuntimeContext: string | RuntimeFileOperationArgs
): Promise<void> {
  try {
    const result =
      typeof connectionIdOrRuntimeContext === 'string'
        ? node.isDirectory
          ? await window.api.fs.downloadFolder({
              dirPath: node.path,
              connectionId: connectionIdOrRuntimeContext
            })
          : await window.api.fs.downloadFile({
              filePath: node.path,
              connectionId: connectionIdOrRuntimeContext
            })
        : await downloadRuntimeFile(connectionIdOrRuntimeContext, node.path, node.name)
    // Why: Suppress toasts when the user cancels the native save dialog per design.
    if (result.canceled) {
      return
    }
    // Why: POSIX permits backslashes in saved names; only Windows treats them as separators.
    const savedName = getLocalDownloadName(
      result.destinationPath,
      window.api.platform.get().platform
    )
    toast.success(
      node.isDirectory
        ? translate(
            'auto.components.right.sidebar.FileExplorerRow.a4029c996b',
            "Downloaded folder '{{value0}}'",
            { value0: savedName }
          )
        : translate(
            'auto.components.right.sidebar.FileExplorerRow.bce4d4e44f',
            "Downloaded '{{value0}}'",
            { value0: savedName }
          ),
      {
        action: {
          label: translate('auto.components.right.sidebar.FileExplorerRow.1a3df04ae1', 'Open'),
          onClick: () => {
            void window.api.shell.openPath(result.destinationPath)
          }
        }
      }
    )
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        node.isDirectory
          ? translate(
              'auto.components.right.sidebar.FileExplorerRow.f729bcd97d',
              "Failed to download folder '{{value0}}'.",
              { value0: node.name }
            )
          : translate(
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
