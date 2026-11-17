import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { showDownloadedFileToast } from './downloaded-file-toast'

/** Saves an SSH folder to a path the user picks and reports the outcome; the host must support recursive transfer. */
export async function downloadSshFolder(
  dirPath: string,
  name: string,
  connectionId: string
): Promise<void> {
  try {
    const result = await window.api.fs.downloadFolder({ dirPath, connectionId })
    if (!result.canceled) {
      showDownloadedFileToast(result.destinationPath, true)
    }
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate(
          'auto.components.right.sidebar.FileExplorerRow.f729bcd97d',
          "Failed to download folder '{{value0}}'.",
          { value0: name }
        )
      )
    )
  }
}
