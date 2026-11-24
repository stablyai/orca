import { toast } from 'sonner'
import type { BrowserScreencastDownloadResult } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import {
  browserDownloadToastId,
  emitBrowserClientHostedDownloadNotice
} from '../navigate/browser-client-hosted-download-notices'

/**
 * A streamed page's download lands on its server. The start names where, since a hidden pane stops
 * its stream and may never hear the finish; a heard finish replaces it with the outcome.
 */
export function showRemoteBrowserDownloadNotice(
  event: BrowserScreencastDownloadResult,
  environmentId: string
): void {
  const { download } = event
  const id = browserDownloadToastId(download.downloadId)
  const host = selectExecutionHostDisplayLabel(
    useAppStore.getState(),
    toRuntimeExecutionHostId(environmentId)
  )
  // A claimed download's file is the feature's own, deleted once read: name the feature instead.
  const savePath = download.claimLabel ?? download.savePath
  if (event.type === 'downloadRequested') {
    toast(
      translate('browser.serverPage.download.started', 'Downloading to {{path}} on {{host}}', {
        path: savePath,
        host
      }),
      { id }
    )
    return
  }
  emitBrowserClientHostedDownloadNotice(
    {
      ...event.download,
      // The server's own path; this computer has no copy (moving it here is separate work).
      ...(savePath
        ? { remoteDestination: { workspaceRelativePath: savePath, hostLabel: host } }
        : {})
    },
    savePath?.split(/[\\/]/).pop() ?? ''
  )
}
