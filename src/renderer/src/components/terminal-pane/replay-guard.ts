import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { writeForegroundTerminalChunk } from '@/lib/pane-manager/pane-terminal-foreground-render-settle'

// Why: xterm.js auto-responds to terminal query sequences (DA1 `CSI c`,
// DECRQM `CSI ? Ps $ p`, OSC 10/11 color queries, focus events, CPR) by
// emitting the reply through its onData callback. In pty-connection.ts that
// callback is wired directly to `transport.sendInput`, which pipes the reply
// to the shell's stdin. When we restore terminal state at startup or on
// reattach we write recorded PTY bytes back into xterm — including any
// queries the previous agent CLI emitted — and the auto-replies end up as
// stray characters on the new shell's prompt (e.g. `?1;2c`, `2026;2$y`,
// OSC 10/11 color fragments).
//
// xterm does not expose a `wasUserInput` flag on its public onData, so we
// cannot distinguish replay-induced replies from real keystrokes after the
// fact. Instead, we track an in-flight replay counter per pane: callers
// replay into xterm via `replayIntoTerminal`, which increments the counter,
// writes, and decrements in xterm's write-completion callback. The onData
// handler in pty-connection.ts drops data while the counter is non-zero.
//
// The guard window is bounded by xterm's own parse completion, not a
// wall-clock timer, so only replies generated while parsing the replayed
// bytes are suppressed. User keystrokes typed after the replay completes
// are unaffected. In practice replay finishes within milliseconds — before
// the user could meaningfully type — so the few-ms window where real input
// would also be dropped is acceptable relative to correctness.

export type ReplayingPanesRef = React.RefObject<Map<number, number>>

// Why: the guard normally releases in xterm's write-completion callback, but
// that callback never fires for a pane whose terminal has not been flushed —
// e.g. a cold-restore reattach that replays into a just-mounted / offscreen
// pane. Without a ceiling the counter leaks, isPaneReplaying() stays true, and
// the onData handler silently drops EVERY keystroke (the pane looks alive but
// ignores input). Release deterministically after this bound so the guard
// always clears; in the normal path onParsed fires within milliseconds and
// cancels it first. Tradeoff: if the callback is lost and the pane parses the
// replayed buffer only after this bound elapses (e.g. rendering resumes long
// after restore), xterm's auto-replies to any device queries in that buffer can
// leak to the shell as input. Accepted as strictly preferable to a permanent
// input lockout, and bounded by the ~100 KB replay cap.
const REPLAY_GUARD_RELEASE_FALLBACK_MS = 1000

export function isPaneReplaying(ref: ReplayingPanesRef, paneId: number): boolean {
  return (ref.current.get(paneId) ?? 0) > 0
}

/** Engage the per-pane replay guard and return a `finish` callback that
 *  releases it exactly once. The guard also auto-releases after
 *  REPLAY_GUARD_RELEASE_FALLBACK_MS so a missing xterm parse callback can never
 *  strand it engaged. `onReleased` runs once when the guard actually releases
 *  (via `finish` or the fallback), so async callers can settle either way. */
function engageReplayGuard(
  replayingPanesRef: ReplayingPanesRef,
  paneId: number,
  onReleased?: () => void
): () => void {
  const map = replayingPanesRef.current
  map.set(paneId, (map.get(paneId) ?? 0) + 1)
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    const remaining = (map.get(paneId) ?? 1) - 1
    if (remaining <= 0) {
      map.delete(paneId)
    } else {
      map.set(paneId, remaining)
    }
    onReleased?.()
  }
  const fallback = setTimeout(release, REPLAY_GUARD_RELEASE_FALLBACK_MS)
  return () => {
    clearTimeout(fallback)
    release()
  }
}

/** Writes `data` into the pane's terminal with the replay guard engaged,
 *  so xterm's auto-replies to embedded query sequences do not leak to the
 *  shell as input. The counter increments/decrements so nested replays
 *  (e.g. clear-screen preamble + snapshot body) compose correctly. */
export function replayIntoTerminal(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string
): void {
  if (!data) {
    return
  }
  const finishReplay = engageReplayGuard(replayingPanesRef, pane.id)
  // Why: hidden/snapshot replay bypasses the live foreground write path, but
  // WebGL/canvas renderers still need a post-parse repaint to drop stale cells.
  writeForegroundTerminalChunk(pane.terminal, data, {
    forceViewportRefresh: true,
    followupViewportRefresh: true,
    onParsed: finishReplay
  })
}

export function replayIntoTerminalAsync(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string
): Promise<void> {
  if (!data) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    // Why: settle the promise when the guard releases — via parse completion or
    // the fallback — so an awaiting caller never hangs if xterm's callback for a
    // just-mounted/offscreen pane never arrives.
    const finishReplay = engageReplayGuard(replayingPanesRef, pane.id, resolve)
    writeForegroundTerminalChunk(pane.terminal, data, {
      forceViewportRefresh: true,
      followupViewportRefresh: true,
      onParsed: finishReplay
    })
  })
}
