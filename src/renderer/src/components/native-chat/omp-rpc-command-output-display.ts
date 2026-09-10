// Renders an OMP RPC command's captured stdout as chat text.
//
// The invariant this module exists to hold: command output is stored RAW and
// stripped only here, where it is projected for display. Stripping at ingest is
// wrong because output arrives as a stream of `command-output` frames and one
// SGR sequence can straddle two of them (`/usage` paints truecolour). Given the
// partial accumulation "ESC [", stripAnsiEscapeSequences' generic two/three-byte
// escape pattern consumes that bare introducer, so the next frame's
// "38;2;100;200;50m" has nothing left to attach to and renders as visible
// garbage. Keeping raw bytes in reducer state and in the marker cache means the
// sequence is always whole by the time it is stripped.

import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'

export function ompRpcCommandOutputDisplayText(rawOutputText: string): string {
  return stripAnsiEscapeSequences(rawOutputText)
}
