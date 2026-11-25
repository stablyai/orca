import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'

function getLocalDownloadName(destinationPath: string, platform: NodeJS.Platform): string {
  const lastSeparatorIndex =
    platform === 'win32'
      ? Math.max(destinationPath.lastIndexOf('/'), destinationPath.lastIndexOf('\\'))
      : destinationPath.lastIndexOf('/')
  return destinationPath.slice(lastSeparatorIndex + 1)
}

/** Confirms a finished download by the name it was saved under, with a way to open it. */
export function showDownloadedFileToast(destinationPath: string): void {
  // POSIX allows backslashes in filenames; only Windows treats them as separators.
  const savedName = getLocalDownloadName(destinationPath, window.api.platform.get().platform)
  toast.success(
    translate(
      'auto.components.right.sidebar.FileExplorerRow.bce4d4e44f',
      "Downloaded '{{value0}}'",
      {
        value0: savedName
      }
    ),
    {
      action: {
        label: translate('auto.components.right.sidebar.FileExplorerRow.1a3df04ae1', 'Open'),
        onClick: () => {
          void window.api.shell.openPath(destinationPath, LOCAL_EXECUTION_HOST_ID)
        }
      }
    }
  )
}
