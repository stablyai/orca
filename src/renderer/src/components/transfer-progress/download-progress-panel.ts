import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  RuntimeFileDownloadResult,
  RuntimeFileDownloadTransfer
} from '@/runtime/runtime-file-client'
import { createDownloadProgressTracker, type DownloadProgress } from './download-progress-tracker'
import {
  openTransferProgressPanel,
  type TransferProgressPanelHandle
} from './open-transfer-progress-panel'

/**
 * Shows the transfer panel with a Cancel control while `run` downloads a remote
 * file. A user cancel resolves as `{ canceled: true }`, the same as a dismissed
 * save dialog, so callers keep a single success/error path.
 */
export async function runRemoteDownloadWithProgress(
  name: string,
  run: (transfer: RuntimeFileDownloadTransfer) => Promise<RuntimeFileDownloadResult>
): Promise<RuntimeFileDownloadResult> {
  const rowId = createBrowserUuid()
  const controller = new AbortController()
  // Why: assigned inside the progress callback, which control-flow narrowing cannot see.
  const view: { panel: TransferProgressPanelHandle | null } = { panel: null }

  const cancel = (): void => {
    if (controller.signal.aborted) {
      return
    }
    controller.abort(new Error('Download canceled'))
    view.panel?.markCancelling(rowId)
  }

  const onProgress = (progress: DownloadProgress): void => {
    // Why: the first event arrives once the save dialog has closed, so a
    // dismissed dialog never flashes a panel.
    view.panel ??= openTransferProgressPanel(
      'download',
      [{ transferId: rowId, name, sentBytes: 0, totalBytes: 0, status: 'active' }],
      cancel
    )
    view.panel.updateRow(rowId, {
      sentBytes: progress.transferredBytes,
      totalBytes: progress.totalBytes ?? 0
    })
  }

  try {
    const result = await run({
      signal: controller.signal,
      trackProgress: (totalBytes) => createDownloadProgressTracker({ totalBytes, emit: onProgress })
    })
    // Why: a cancel that lost the race to completion still ends as a download; the caller's
    // "Downloaded … / Open" toast states that, so the panel never claims "Cancelled".
    view.panel?.close()
    return result
  } catch (error) {
    if (controller.signal.aborted) {
      view.panel?.updateRow(rowId, { status: 'cancelled' })
      view.panel?.settle()
      return { canceled: true }
    }
    view.panel?.close()
    throw error
  }
}
