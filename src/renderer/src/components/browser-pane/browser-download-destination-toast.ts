import { toast } from 'sonner'
import type { BrowserDownloadFinishedEvent } from '../../../../shared/browser-guest-events'
import { translate } from '@/i18n/i18n'

export function formatBrowserRemoteDownloadMessage(destination: {
  workspaceRelativePath: string
  hostLabel: string
}): string {
  return translate(
    'auto.components.browser.pane.download.savedToRemote',
    'Saved to {{value1}} on {{value2}}',
    {
      value1: destination.workspaceRelativePath,
      value2: destination.hostLabel
    }
  )
}

// Name the remote path and host; client-hosted downloads never land in this desktop’s Downloads folder.
export function emitBrowserRemoteDownloadToast(event: BrowserDownloadFinishedEvent): boolean {
  if (event.status !== 'completed' || !event.remoteDestination) {
    return false
  }
  toast.success(formatBrowserRemoteDownloadMessage(event.remoteDestination))
  return true
}
