import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../../../shared/ansi-escape-sequences'

/** Only printable snapshot content can authorize permanent baseline dedup; imageless coverage claims must preserve redelivery as the remaining copy of those bytes (STA-5179). */
export function restoredSnapshotPaintsPrintableContent(snapshot: {
  data?: string
  scrollbackAnsi?: string
}): boolean {
  return hasPrintableContent(snapshot.data) || hasPrintableContent(snapshot.scrollbackAnsi)
}

function hasPrintableContent(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  return (
    stripAnsiEscapeSequences(value).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '').trim().length >
    0
  )
}
