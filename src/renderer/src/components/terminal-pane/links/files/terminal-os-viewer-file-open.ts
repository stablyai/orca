import { hasOsViewerOnlyFileExtension } from '../../../../../../shared/binary-file-extensions'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { downloadAndOpenRemoteTerminalFile } from '../../terminal-remote-file-download-open'

/**
 * The editor can only say "Binary file — cannot display" for these, so an ordinary
 * click takes the Shift+Cmd/Ctrl route to the app the OS registers for the file type.
 * Returns false when the editor should still open the file, as for a granted file its host cannot page.
 */
export async function openOsViewerOnlyTerminalFile(
  fileContext: RuntimeFileOperationArgs,
  filePath: string,
  canOpenLocally: boolean,
  isRequestCurrent: () => boolean,
  grant: { terminalArtifactGrantId: string } | null = null
): Promise<boolean> {
  if (!hasOsViewerOnlyFileExtension(filePath)) {
    return false
  }
  if (!canOpenLocally) {
    return downloadAndOpenRemoteTerminalFile(fileContext, filePath, {
      grant,
      isCurrent: isRequestCurrent
    })
  }
  const opened = await window.api.shell.openFilePath(filePath, LOCAL_EXECUTION_HOST_ID)
  return opened || !isRequestCurrent()
}
