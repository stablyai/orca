import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../../../shared/ansi-escape-sequences'

/**
 * Whether a restored model snapshot painted any printable cell content.
 *
 * Why this gates the restore baseline (STA-5179): the baseline makes every
 * chunk at or below the snapshot's `seq` unrecoverable, on the model's word
 * that those bytes are already painted. An image with no printable characters
 * cannot be the rendering of the output it claims to cover, so the claim is
 * disproven and the redelivery is the only remaining copy of those bytes.
 * Replaying it into the blank screen the snapshot just produced also cannot
 * duplicate visible output, so refusing to arm is the safe direction.
 */
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
