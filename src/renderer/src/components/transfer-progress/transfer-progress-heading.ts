import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

type HeadingInput = {
  rowCount: number
  settled: boolean
  doneCount: number
  cancelledCount: number
}

/** Counts files while running, states the outcome once everything has stopped. */
export function formatTransferProgressHeading(
  { rowCount, settled, doneCount, cancelledCount }: HeadingInput,
  t: Translate = translate
): string {
  if (!settled) {
    return t('transferProgress.heading.upload.active', 'Uploading {{count}} items', {
      count: rowCount,
      defaultValue_one: 'Uploading {{count}} item'
    })
  }
  // Why: only an all-cancelled transfer reads as cancelled; a failure among the cancels must show.
  if (doneCount === 0 && cancelledCount > 0 && cancelledCount === rowCount) {
    return t('transferProgress.heading.upload.cancelled', 'Upload cancelled')
  }
  if (doneCount === 0) {
    return t('transferProgress.heading.upload.failed', 'Upload failed')
  }
  if (doneCount < rowCount) {
    return t('transferProgress.heading.upload.partial', 'Uploaded {{doneCount}} of {{rowCount}}', {
      doneCount,
      rowCount
    })
  }
  return t('transferProgress.heading.upload.done', 'Uploaded {{count}} items', {
    count: rowCount,
    defaultValue_one: 'Uploaded {{count}} item'
  })
}
