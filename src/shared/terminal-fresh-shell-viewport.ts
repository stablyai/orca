/**
 * Scrolls a restored screen into scrollback and homes the cursor, so a fresh shell's first prompt
 * starts on a blank viewport instead of beside the dead shell's last prompt.
 */
export function buildFreshShellViewportBlankingSequence(rows: number): string {
  const viewportRows = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 24))
  // Why: newline scrolling preserves restored rows in xterm scrollback; CSI S
  // drops them. Reset margins first so stale TUI scroll regions cannot trap it.
  return `\x1b[?6l\x1b[r\x1b[${viewportRows};1H${'\r\n'.repeat(viewportRows)}\x1b[H`
}
