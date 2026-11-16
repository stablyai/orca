/** Keep restored history in scrollback while a fresh shell starts on a blank viewport. */
export function buildFreshShellViewportBlankingSequence(rows: number): string {
  const viewportRows = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 24))
  // Newlines preserve scrollback unlike CSI S; reset stale TUI margins so scrolling reaches the full viewport.
  return `\x1b[?6l\x1b[r\x1b[${viewportRows};1H${'\r\n'.repeat(viewportRows)}\x1b[H`
}

/**
 * Where a fresh shell starts after restored history. ConPTY repaints its whole viewport by
 * coordinates over the restored rows, so a Windows-owned shell starts on a blank viewport; any
 * other shell prints its prompt on the line below the history, which stays in view.
 */
export function buildFreshShellViewportSequence(rows: number, ownerIsConpty: boolean): string {
  return ownerIsConpty ? buildFreshShellViewportBlankingSequence(rows) : '\r\n'
}
