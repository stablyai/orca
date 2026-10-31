import { translate } from '@/i18n/i18n'

type HeadingInput = {
  rowCount: number
  settled: boolean
  doneCount: number
  cancelledCount: number
}

/** Counts files while running, states the outcome once everything has stopped. */
export function formatTransferProgressHeading({
  rowCount,
  settled,
  doneCount,
  cancelledCount
}: HeadingInput): string {
  if (!settled) {
    return translate('transferProgress.heading.upload.active', 'Uploading {{count}} items', {
      count: rowCount,
      defaultValue_one: 'Uploading {{count}} item'
    })
  }
  // Why: only an all-cancelled transfer reads as cancelled; a failure among the cancels must show.
  if (doneCount === 0 && cancelledCount > 0 && cancelledCount === rowCount) {
    return translate('transferProgress.heading.upload.cancelled', 'Upload cancelled')
  }
  if (doneCount === 0) {
    return translate('transferProgress.heading.upload.failed', 'Upload failed')
  }
  if (doneCount < rowCount) {
    return translate(
      'transferProgress.heading.upload.partial',
      'Uploaded {{doneCount}} of {{rowCount}}',
      { doneCount, rowCount }
    )
  }
  return translate('transferProgress.heading.upload.done', 'Uploaded {{count}} items', {
    count: rowCount,
    defaultValue_one: 'Uploaded {{count}} item'
  })
}
