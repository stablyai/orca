import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  RuntimeFileDownloadResult,
  RuntimeFileDownloadTransfer
} from '@/runtime/runtime-file-client'
import {
  createRemoteDownloadProgressTracker,
  type RemoteDownloadProgress
} from '../../../../shared/remote-download-progress'
import {
  openTransferProgressPanel,
  type TransferProgressPanelHandle
} from './open-transfer-progress-panel'

type RemoteDownloadItem = { name: string; isDirectory: boolean }

/**
 * Shows the transfer panel with a Cancel control while `run` downloads a remote
 * file or folder. A user cancel resolves as `{ canceled: true }`, the same as a
 * dismissed save dialog, so callers keep a single success/error path.
 */
export async function runRemoteDownloadWithProgress(
  item: RemoteDownloadItem,
  run: (transfer: RuntimeFileDownloadTransfer) => Promise<RuntimeFileDownloadResult>
): Promise<RuntimeFileDownloadResult> {
  const downloadId = createBrowserUuid()
  const controller = new AbortController()
  // Why: assigned inside the progress callback, which control-flow narrowing cannot see.
  const view: { panel: TransferProgressPanelHandle | null } = { panel: null }

  const cancel = (): void => {
    if (controller.signal.aborted) {
      return
    }
    controller.abort(new Error('Download canceled'))
    view.panel?.markCancelling(downloadId)
    void window.api.fs.cancelDownload({ downloadId }).catch(() => {})
  }

  const onProgress = (progress: RemoteDownloadProgress): void => {
    // Why: the first event arrives once the save dialog has closed, so a
    // dismissed dialog never flashes a panel.
    view.panel ??= openTransferProgressPanel(
      'download',
      [{ transferId: downloadId, name: item.name, sentBytes: 0, totalBytes: 0, status: 'active' }],
      cancel
    )
    view.panel.updateRow(downloadId, {
      sentBytes: progress.transferredBytes,
      totalBytes: progress.totalBytes ?? 0
    })
  }

  const unsubscribe = window.api.fs.onDownloadProgress((progress) => {
    if (progress.downloadId === downloadId) {
      onProgress(progress)
    }
  })

  try {
    const result = await run({
      downloadId,
      signal: controller.signal,
      trackLocalProgress: (totalBytes) =>
        createRemoteDownloadProgressTracker({ downloadId, totalBytes, emit: onProgress })
    })
    // Why: a cancel that lost the race to completion still ends as a download; the caller's
    // "Downloaded … / Open" toast states that, so the panel never claims "Cancelled".
    view.panel?.close()
    return result
  } catch (error) {
    if (controller.signal.aborted) {
      view.panel?.updateRow(downloadId, { status: 'cancelled' })
      view.panel?.settle()
      return { canceled: true }
    }
    view.panel?.close()
    throw error
  } finally {
    unsubscribe()
  }
}
