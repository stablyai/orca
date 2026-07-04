import type { RefObject } from 'react'

export type RestoredViewportBlankingPanesRef = RefObject<Set<number>>

export function buildFreshShellViewportBlankingSequence(rows: number): string {
  const viewportRows = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 24))
  // Why: newline scrolling preserves restored rows in xterm scrollback; CSI S
  // blanks the viewport but drops those rows from the normal buffer.
  return `\x1b[${viewportRows};1H${'\r\n'.repeat(viewportRows)}\x1b[H`
}
