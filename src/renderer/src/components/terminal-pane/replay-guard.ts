import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { writeForegroundTerminalChunk } from '@/lib/pane-manager/pane-terminal-foreground-render-settle'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { ensureArabicShapingJoinerForText } from '@/lib/pane-manager/terminal-arabic-shaping-joiner'

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

// Why stall handling exists: the decrement above only runs when xterm
// completes the write. A wedged WriteBuffer (sync throw escaping a parse
// handler or a write-completion callback — see
// xterm-write-buffer-stall.repro.test.ts) or a disposed-terminal race can
// drop that completion forever, leaving the guard latched on a live pane —
// which silently eats every keystroke (Discord #performance / issue #2836).
//
// Why release is probe-certified, never time-based: a blind timeout release
// while a slow replay is still parsing would let xterm's auto-replies leak
// into the shell — and into agent TUIs, where a leaked ESC reads as the user
// pressing Escape. Instead, when a completion looks overdue we enqueue an
// empty probe write. xterm parses writes in order, so only three states are
// possible, and release is provably safe in every state that releases:
//   1. probe completes, replay callback already ran   → normal release won.
//   2. probe completes, replay callback never ran     → every replay byte has
//      parsed (FIFO), so no further auto-replies can exist; the completion
//      was genuinely lost. Release.
//   3. probe never completes                          → the pipeline is
//      wedged; a dead parser can never emit auto-replies, so releasing after
//      a bounded wait cannot leak anything — and the pane needs recovery,
//      which the breadcrumb reports.
// While the probe is pending (slow-but-alive replay), the guard HOLDS.
const REPLAY_GUARD_STALL_CHECK_MS = 10_000

type ReplayTerminalOptions = {
  shouldRefreshViewportSynchronously?: () => boolean
  stallCheckMs?: number
}

export function isPaneReplaying(ref: ReplayingPanesRef, paneId: number): boolean {
  return (ref.current.get(paneId) ?? 0) > 0
}

type ReplayGuardWriteTarget = Pick<ManagedPane['terminal'], 'write'>

/**
 * Engage the replay counter for one write and return the release function.
 * Release runs exactly once — from xterm's write completion or, failing
 * that, from the probe-certified stall path — so a lost completion cannot
 * latch the guard.
 */
function engageReplayGuard(
  map: Map<number, number>,
  paneId: number,
  terminal: ReplayGuardWriteTarget,
  stallCheckMs: number,
  onRelease?: () => void
): () => void {
  map.set(paneId, (map.get(paneId) ?? 0) + 1)
  let released = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const release = (reason: 'parsed' | 'lost-completion' | 'wedged'): void => {
    if (released) {
      return
    }
    released = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const remaining = (map.get(paneId) ?? 1) - 1
    if (remaining <= 0) {
      map.delete(paneId)
    } else {
      map.set(paneId, remaining)
    }
    if (reason === 'lost-completion') {
      console.error(
        `[terminal] replay guard released for pane ${paneId} — the probe write parsed but the replay completion never arrived (lost write callback)`
      )
      recordRendererCrashBreadcrumb('terminal_replay_guard_lost_completion', { paneId })
    } else if (reason === 'wedged') {
      console.error(
        `[terminal] replay guard released for pane ${paneId} — the probe write never parsed (wedged xterm write pipeline; pane likely needs recovery)`
      )
      recordRendererCrashBreadcrumb('terminal_replay_guard_wedged_release', { paneId })
    }
    onRelease?.()
  }
  const probeForStall = (): void => {
    if (released) {
      return
    }
    try {
      // FIFO certification: this callback can only run after every replay
      // byte queued before it has parsed (state 2 above).
      terminal.write('', () => release('lost-completion'))
    } catch {
      // write threw (terminal disposed mid-replay): nothing will ever parse,
      // so no auto-replies can leak.
      release('wedged')
      return
    }
    timer = setTimeout(() => release('wedged'), stallCheckMs)
  }
  timer = setTimeout(probeForStall, stallCheckMs)
  return () => release('parsed')
}

/** Writes `data` into the pane's terminal with the replay guard engaged,
 *  so xterm's auto-replies to embedded query sequences do not leak to the
 *  shell as input. The counter increments/decrements so nested replays
 *  (e.g. clear-screen preamble + snapshot body) compose correctly. */
export function replayIntoTerminal(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string,
  options: ReplayTerminalOptions = {}
): void {
  if (!data) {
    return
  }
  ensureArabicShapingJoinerForText(pane.terminal, data)
  const releaseParsed = engageReplayGuard(
    replayingPanesRef.current,
    pane.id,
    pane.terminal,
    options.stallCheckMs ?? REPLAY_GUARD_STALL_CHECK_MS
  )
  // Why: hidden/snapshot replay bypasses the live foreground write path, but
  // WebGL/canvas renderers still need a post-parse repaint to drop stale cells.
  writeForegroundTerminalChunk(pane.terminal, data, {
    forceViewportRefresh: true,
    followupViewportRefresh: true,
    shouldRefreshViewportSynchronously: options.shouldRefreshViewportSynchronously,
    onParsed: releaseParsed
  })
}

export function replayIntoTerminalAsync(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string,
  options: ReplayTerminalOptions = {}
): Promise<void> {
  if (!data) {
    return Promise.resolve()
  }
  ensureArabicShapingJoinerForText(pane.terminal, data)
  return new Promise((resolve) => {
    // Why resolve on either release path: callers await this to sequence
    // restore steps; a lost write completion must not hang the restore chain.
    const releaseParsed = engageReplayGuard(
      replayingPanesRef.current,
      pane.id,
      pane.terminal,
      options.stallCheckMs ?? REPLAY_GUARD_STALL_CHECK_MS,
      resolve
    )
    writeForegroundTerminalChunk(pane.terminal, data, {
      forceViewportRefresh: true,
      followupViewportRefresh: true,
      shouldRefreshViewportSynchronously: options.shouldRefreshViewportSynchronously,
      onParsed: releaseParsed
    })
  })
}
