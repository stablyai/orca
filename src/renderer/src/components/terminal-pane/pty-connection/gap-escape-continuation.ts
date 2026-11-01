import {
  advanceTerminalEscapeBoundary,
  skipOpenEscapeContinuation
} from '../../../../../shared/terminal-partial-escape-tail'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Skip a post-gap chunk's continuation of an escape whose start main dropped, unless a replay re-armed that escape in xterm (#33766). */
export function skipGapEscapeContinuation(
  session: ConnectPanePtySession,
  data: string,
  gapEscapeState: string | undefined
): string {
  if (gapEscapeState && !session.idleCursorReset.insideEscape) {
    session.gapEscapeContinuation = gapEscapeState
  }
  if (!session.gapEscapeContinuation) {
    return data
  }
  const skipped = skipOpenEscapeContinuation(session.gapEscapeContinuation, data)
  session.gapEscapeContinuation = skipped.stillOpen
  return skipped.rest
}

/** The escape left open where `original` was cut down to its suffix `rest`, given the escape its first byte resumed inside; a snapshot-seq cut can land mid-escape (#33766). */
export function escapeOpenAtCut(
  original: string,
  rest: string,
  gapEscapeState: string | undefined
): string | undefined {
  if (rest === original) {
    return gapEscapeState
  }
  if (!original.endsWith(rest)) {
    return undefined
  }
  const dropped = original.slice(0, original.length - rest.length)
  return advanceTerminalEscapeBoundary(gapEscapeState ?? '', dropped) || undefined
}
