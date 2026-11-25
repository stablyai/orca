import { toast } from 'sonner'
import type { BrowserScreencastDownloadResult } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { formatBrowserRemoteDownloadMessage } from '../navigate/browser-download-destination-toast'
import { offerRemoteBrowserDownloadCopy } from './remote-browser-download-copy'
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
  target: RuntimeClientTarget & { kind: 'environment' }
): void {
  const { download } = event
  const id = browserDownloadToastId(download.downloadId)
  const host = selectExecutionHostDisplayLabel(
    useAppStore.getState(),
    toRuntimeExecutionHostId(target.environmentId)
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
  if (event.copyId && !download.claimLabel && savePath && download.status === 'completed') {
    offerRemoteBrowserDownloadCopy({
      toastId: id,
      target,
      copyId: event.copyId,
      savedOnServer: formatBrowserRemoteDownloadMessage({
        workspaceRelativePath: savePath,
        hostLabel: host
      }),
      filename: savePath.split(/[\\/]/).pop() || 'download'
    })
    return
  }
  emitBrowserClientHostedDownloadNotice(
    {
      ...event.download,
      // The server's own path; this computer has no copy.
      ...(savePath
        ? { remoteDestination: { workspaceRelativePath: savePath, hostLabel: host } }
        : {})
    },
    savePath?.split(/[\\/]/).pop() ?? ''
  )
}
