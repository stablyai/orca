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
  const plural = rowCount === 1 ? '' : 's'
  if (!settled) {
    return translate(
      'auto.components.terminal.pane.terminal.drop.upload.heading',
      'Uploading {{value0}} file{{value1}} to runtime',
      { value0: rowCount, value1: plural }
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
      'Uploaded {{value0}} of {{value1}} to runtime',
      { value0: doneCount, value1: rowCount }
    )
  }
  return translate(
    'auto.components.terminal.pane.terminal.drop.upload.heading.done',
    'Uploaded {{value0}} file{{value1}} to runtime',
    { value0: rowCount, value1: plural }
  )
}
