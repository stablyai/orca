import { translate } from '@/i18n/i18n'

type HeadingInput = {
  rowCount: number
  settled: boolean
  doneCount: number
  cancelledCount: number
}

/** Counts files while running, states the outcome once everything has stopped. */
export function formatTerminalDropUploadHeading({
  rowCount,
  settled,
  doneCount,
  cancelledCount
}: HeadingInput): string {
  if (!settled) {
    return translate(
      'auto.components.terminal.pane.terminal.drop.upload.heading.uploading',
      'Uploading {{count}} files to runtime',
      { count: rowCount }
    )
  }
  if (doneCount === 0 && cancelledCount > 0) {
    return translate(
      'auto.components.terminal.pane.terminal.drop.upload.heading.cancelled',
      'Upload cancelled'
    )
  }
  if (doneCount === 0) {
    return translate(
      'auto.components.terminal.pane.terminal.drop.upload.heading.failed',
      'Upload failed'
    )
  }
  if (doneCount < rowCount) {
    return translate(
      'auto.components.terminal.pane.terminal.drop.upload.heading.partial',
      'Uploaded {{doneCount}} of {{rowCount}} to runtime',
      { doneCount, rowCount }
    )
  }
  return translate(
    'auto.components.terminal.pane.terminal.drop.upload.heading.done',
    'Uploaded {{count}} files to runtime',
    { count: rowCount }
  )
}
