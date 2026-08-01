/**
 * Retained size of live xterm buffers, in scrollback lines and cells.
 *
 * Why its own module: a PaneManager reads this straight off its internal pane map,
 * while the registry falls back to the public `getPanes()` view for managers that
 * do not expose one. Both funnel through here so the two paths cannot drift.
 */

type XtermBufferShape = {
  cols?: number
  buffer?: { active?: { type?: string }; normal?: { length?: number } }
}

export type TerminalBufferCensus = {
  panes: number
  lines: number
  cells: number
  altScreenPanes: number
  /** Panes whose buffer could not be read — a lower bound, never decremented. */
  droppedPanes: number
}

export function sumTerminalBufferSizes(
  managedPanes: Iterable<{ terminal: unknown }>
): TerminalBufferCensus {
  let panes = 0
  let lines = 0
  let cells = 0
  let altScreenPanes = 0
  let droppedPanes = 0
  for (const pane of managedPanes) {
    try {
      const terminal = pane.terminal as XtermBufferShape | undefined
      // Why `normal` and not `active`: `active` is the alternate buffer whenever an
      // alt-screen app is up (vim, less, an agent TUI). That buffer is viewport-sized
      // and holds no scrollback — measured on @xterm/headless as 24 rows against
      // `normal`'s 5001 — so reading it clears terminals of a leak they are causing.
      const retained = terminal?.buffer?.normal?.length ?? 0
      // Why counted separately rather than folded in: one number cannot say both how
      // much is retained and which pane shape retained it.
      const onAltScreen = terminal?.buffer?.active?.type === 'alternate'
      // Why commit together: a throw mid-read must not leave a pane counted with its
      // lines missing, which reads as a pane retaining nothing.
      panes += 1
      lines += retained
      cells += retained * (terminal?.cols ?? 0)
      altScreenPanes += onAltScreen ? 1 : 0
    } catch {
      // Why kept although a disposed xterm returns values rather than throwing
      // (measured): `terminal` is reached through a pane the caller may be tearing
      // down, and one bad pane must not sink the census for its siblings. Counted
      // rather than swallowed so a low `panes` cannot read as "few terminals live".
      droppedPanes += 1
    }
  }
  return { panes, lines, cells, altScreenPanes, droppedPanes }
}
