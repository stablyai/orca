import type { RuntimeImportProgressHandlers } from '@/runtime/runtime-upload-progress-tracker'
import {
  openTransferProgressPanel,
  type TransferPanelScope,
  type TransferProgressPanelHandle
} from './open-transfer-progress-panel'

export type UploadProgressPanel = {
  progress: RuntimeImportProgressHandlers
  /** Tears the panel down for a flow that failed before it could settle. */
  close: () => void
}

/** Import progress handlers that drive one upload panel; it opens once rows exist. */
export function createUploadProgressPanel(scope?: TransferPanelScope): UploadProgressPanel {
  let panel: TransferProgressPanelHandle | null = null
  // Why: per row, since a path dropped twice is two rows and can be cancelled once.
  const cancelledUploadIds = new Set<string>()
  const cancelRow = (uploadId: string): void => {
    cancelledUploadIds.add(uploadId)
    panel?.markCancelling(uploadId)
    void window.api.fs.cancelRuntimeUpload({ uploadId }).catch(() => {})
  }
  return {
    progress: {
      onStart: (rows) => {
        // Why: a drop that stages nothing never flashes an empty panel.
        if (rows.length === 0) {
          return
        }
        panel = openTransferProgressPanel(
          'upload',
          rows.map((row) => ({
            transferId: row.uploadId,
            name: row.name,
            sentBytes: 0,
            totalBytes: row.totalBytes,
            status: 'active' as const,
            ...(row.kind ? { kind: row.kind } : {})
          })),
          cancelRow,
          scope
        )
      },
      onRowProgress: (uploadId, sentBytes, totalBytes, kind) =>
        panel?.updateRow(uploadId, {
          sentBytes,
          ...(totalBytes === undefined ? {} : { totalBytes }),
          ...(kind ? { kind } : {})
        }),
      onRowSettled: (uploadId, status, detail) => {
        // Why: a cancelled source reports failed; one that finished anyway reports done.
        panel?.updateRow(uploadId, {
          status: status === 'failed' && cancelledUploadIds.has(uploadId) ? 'cancelled' : status,
          ...(detail ? { detail } : {})
        })
      },
      isCancelled: (uploadId) => cancelledUploadIds.has(uploadId),
      onFinish: () => panel?.settle()
    },
    close: () => panel?.close()
  }
}
