function viewportRows(rows: number): number {
  return Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 24))
}

// Reset stale TUI margins and origin mode, then park on the last row: both moves are absolute.
function groundOnLastRow(rows: number): string {
  return `\x1b[?6l\x1b[r\x1b[${viewportRows(rows)};1H`
}

/** Keep restored history in scrollback while a fresh shell starts on a blank viewport. */
export function buildFreshShellViewportBlankingSequence(rows: number): string {
  // Newlines preserve scrollback unlike CSI S.
  return `${groundOnLastRow(rows)}${'\r\n'.repeat(viewportRows(rows))}\x1b[H`
}

/**
 * Where a fresh shell starts after restored history. ConPTY repaints its whole viewport by
 * coordinates over the restored rows, so a Windows-owned shell starts on a blank viewport. Any
 * other shell starts on a new last row, keeping the history in view; the dead process's cursor
 * can sit mid-screen (an agent's input box), so the start never depends on it.
 */
export function buildFreshShellViewportSequence(rows: number, ownerIsConpty: boolean): string {
  return ownerIsConpty
    ? buildFreshShellViewportBlankingSequence(rows)
    : `${groundOnLastRow(rows)}\r\n`
}
