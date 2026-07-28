/**
 * Releases a DEC 2026 (synchronized output) frame that a TUI left open across a
 * hide, so reveal repaints are not silently swallowed.
 *
 * Why: alt-screen agent TUIs (OpenCode/OpenTUI, Codex, grok) bracket every
 * repaint in `?2026h … ?2026l`. If the pane is hidden mid-bracket — the exact
 * moment a worktree switch or cold-park lands, since the fixture writes these
 * brackets many times a second — xterm keeps `decPrivateModes.synchronizedOutput`
 * latched. RenderService.refreshRows then buffers instead of rendering, and it
 * checks that BEFORE the sync flag, so on reveal every repaint Orca owns is a
 * no-op: the forced render-pause repaint, the plain `refresh()` fallback, and
 * the shared glyph-atlas rebuild all render zero rows. The canvas keeps
 * compositing pre-hide pixels while xterm's buffer is perfectly correct.
 *
 * xterm's 1s safety timeout does NOT bound this: it is armed only inside
 * `bufferRows`, and `refreshRows` returns at its `_isPaused` check first — so
 * while a pane is occluded nothing reaches `bufferRows` and no timer is ever
 * pending. A pane hidden mid-frame holds the latch with no watchdog behind it,
 * indefinitely. (terminal-reveal-draw-command-probe.spec.ts asserts exactly
 * this: latch set, `_timeout === undefined`, and a repaint drawing 0 instances.)
 * Resizing the window "fixes" it because SIGWINCH makes the TUI repaint, and
 * that repaint's closing `?2026l` clears the latch — exactly the workaround
 * users report (STA-2694).
 *
 * Reveal is a safe place to drop the latch: a frame opened before the pane was
 * hidden can no longer be completed atomically, and its content is already in
 * the buffer. Clearing it costs at most one extra repaint of a frame the TUI
 * was mid-way through, versus a terminal that stays visibly corrupted.
 *
 * All access is behind typeof guards: an xterm upgrade that renames these
 * internals degrades to a no-op rather than throwing into a render frame.
 */

type MaybeSynchronizedOutputModes = {
  synchronizedOutput?: boolean
}

type TerminalWithSynchronizedOutput = {
  _core?: {
    coreService?: { decPrivateModes?: MaybeSynchronizedOutputModes }
    _renderService?: { _syncOutputHandler?: { flush?: () => unknown } }
  }
}

function getDecPrivateModes(terminal: unknown): MaybeSynchronizedOutputModes | null {
  const modes = (terminal as TerminalWithSynchronizedOutput | null)?._core?.coreService
    ?.decPrivateModes
  return modes && typeof modes === 'object' ? modes : null
}

/**
 * Clears a synchronized-output latch left open across a hide.
 *
 * Returns true when a latch was actually released, so callers can treat it as
 * "this pane needs a repaint now" — the buffered rows are dropped with the
 * latch, and the caller's own full refresh is what repaints them.
 */
export function releaseAbandonedSynchronizedOutput(terminal: unknown): boolean {
  const modes = getDecPrivateModes(terminal)
  if (modes?.synchronizedOutput !== true) {
    return false
  }
  modes.synchronizedOutput = false
  try {
    // Why: drop the handler's buffered row range with the latch. Leaving it
    // armed would let a later flush widen an unrelated refresh to rows this
    // pane is about to repaint in full anyway, and keeps its 1s timer alive.
    const handler = (terminal as TerminalWithSynchronizedOutput)._core?._renderService
      ?._syncOutputHandler
    handler?.flush?.()
  } catch {
    // The latch is already cleared; a failed flush must not block the repaint.
  }
  return true
}
