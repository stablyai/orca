import { translate } from '@/i18n/i18n'
import type { TransferDirection } from './transfer-session-state'

type HeadingInput = {
  direction: TransferDirection
  rowCount: number
  settled: boolean
  doneCount: number
  cancelledCount: number
}

/** Counts files while running, states the outcome once everything has stopped. */
export function formatTransferProgressHeading({
  direction,
  rowCount,
  settled,
  doneCount,
  cancelledCount
}: HeadingInput): string {
  const upload = direction === 'upload'
  if (!settled) {
    return upload
      ? translate('transferProgress.heading.upload.active', 'Uploading {{count}} items', {
          count: rowCount
        })
      : translate('transferProgress.heading.download.active', 'Downloading {{count}} items', {
          count: rowCount
        })
  }
  // Why: only an all-cancelled transfer reads as cancelled; a failure among the cancels must show.
  if (doneCount === 0 && cancelledCount > 0 && cancelledCount === rowCount) {
    return upload
      ? translate('transferProgress.heading.upload.cancelled', 'Upload cancelled')
      : translate('transferProgress.heading.download.cancelled', 'Download cancelled')
  }
  if (doneCount === 0) {
    return upload
      ? translate('transferProgress.heading.upload.failed', 'Upload failed')
      : translate('transferProgress.heading.download.failed', 'Download failed')
  }
  if (doneCount < rowCount) {
    return upload
      ? translate(
          'transferProgress.heading.upload.partial',
          'Uploaded {{doneCount}} of {{rowCount}}',
          {
            doneCount,
            rowCount
          }
        )
      : translate(
          'transferProgress.heading.download.partial',
          'Downloaded {{doneCount}} of {{rowCount}}',
          { doneCount, rowCount }
        )
  }
  return upload
    ? translate('transferProgress.heading.upload.done', 'Uploaded {{count}} items', {
        count: rowCount
      })
    : translate('transferProgress.heading.download.done', 'Downloaded {{count}} items', {
        count: rowCount
      })
}
