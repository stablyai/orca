import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { writeForegroundTerminalChunk } from '@/lib/pane-manager/pane-terminal-foreground-render-settle'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { ensureArabicShapingJoinerForText } from '@/lib/pane-manager/terminal-arabic-shaping-joiner'
import {
  captureTerminalParseProgressGeneration,
  hasTerminalParseProgressSince,
  isTerminalWritePipelineCertifiedDead,
  notifyUndeliverableWrite,
  recordTerminalParseProgress
} from '@/lib/pane-manager/terminal-write-pipeline-health'

// Why this guard exists: xterm auto-replies to query sequences (DA1/DECRQM/OSC 10-11/CPR) via onData → shell stdin, so replaying recorded PTY bytes leaks stray replies onto the new shell's prompt.
// No wasUserInput flag distinguishes replay replies from real keystrokes, so a per-pane in-flight counter gates onData; bounded by xterm's parse completion (not a timer), only auto-replies from replayed bytes are dropped.

export type ReplayingPanesRef = React.RefObject<Map<number, number>>

// Why stall handling exists: the decrement only runs on xterm's write completion; a wedged WriteBuffer or disposed-terminal race can drop it forever, latching the guard so it eats every keystroke (issue #2836).
// Why release is probe-certified, not time-based: a blind timeout during a slow replay would leak xterm auto-replies into the shell/agent TUIs, so an empty FIFO probe certifies wedged only after a fully quiet window.
const REPLAY_GUARD_STALL_CHECK_MS = 10_000

type ReplayTerminalOptions = {
  shouldRefreshViewportSynchronously?: () => boolean
  shouldReleaseRenderPause?: () => boolean
  stallCheckMs?: number
}

export function isPaneReplaying(ref: ReplayingPanesRef, paneId: number): boolean {
  return (ref.current.get(paneId) ?? 0) > 0
}

type ReplayGuardWriteTarget = Pick<ManagedPane['terminal'], 'write'>
type ReplayGuardWriteCallbacks = {
  onParsed: () => void
  onWriteFailure: () => void
}

/**
 * Engage the replay counter for one write and return its settlement callbacks.
 * Release runs exactly once — from write completion or the probe-certified stall
 * path — so a lost completion cannot latch the guard.
 */
function engageReplayGuard(
  map: Map<number, number>,
  paneId: number,
  terminal: ReplayGuardWriteTarget,
  stallCheckMs: number,
  onRelease?: () => void
): ReplayGuardWriteCallbacks {
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
        `[terminal] replay guard released for pane ${paneId} — xterm rejected the replay write or its probe never parsed (undeliverable write pipeline; pane likely needs recovery)`
      )
      recordRendererCrashBreadcrumb('terminal_replay_guard_wedged_release', { paneId })
      // Why: a rejected replay or silent probe makes the pipeline undeliverable; recover instead of a fossil that eats input.
      notifyUndeliverableWrite(terminal, 'replay-wedged')
    }
    onRelease?.()
  }
  const armWedgeDeadline = (quietSinceGeneration: number): void => {
    timer = setTimeout(() => {
      if (released) {
        return
      }
      // Why: completions after the probe prove the FIFO is alive, just behind; certify wedged only after a fully quiet window.
      if (hasTerminalParseProgressSince(terminal, quietSinceGeneration)) {
        armWedgeDeadline(captureTerminalParseProgressGeneration(terminal))
        return
      }
      release('wedged')
    }, stallCheckMs)
  }
  const probeForStall = (): void => {
    if (released) {
      return
    }
    const probeQueuedAtGeneration = captureTerminalParseProgressGeneration(terminal)
    try {
      // FIFO certification: this callback runs only after every replay byte queued before it has parsed.
      terminal.write('', () => {
        recordTerminalParseProgress(terminal)
        release('lost-completion')
      })
    } catch {
      // write threw (terminal disposed mid-replay): nothing will parse, so no auto-replies can leak.
      release('wedged')
      return
    }
    armWedgeDeadline(probeQueuedAtGeneration)
  }
  timer = setTimeout(probeForStall, stallCheckMs)
  return {
    onParsed: () => {
      // Why record even after release: a late completion is still parse progress that sibling guards' wedge deadlines consult.
      recordTerminalParseProgress(terminal)
      release('parsed')
    },
    // A rejected write produced no auto-replies, so release immediately without recording fake parser progress.
    onWriteFailure: () => release('wedged')
  }
}

/** Writes `data` into the pane's terminal with the replay guard engaged, so
 *  xterm's auto-replies to embedded query sequences don't leak to the shell.
 *  The counter increments/decrements so nested replays compose correctly. */
export function replayIntoTerminal(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string,
  options: ReplayTerminalOptions = {}
): void {
  if (!data) {
    return
  }
  // Why: a certified-dead pipeline never parses; retrying only re-arms a guard for another wedged release, so skip it.
  if (isTerminalWritePipelineCertifiedDead(pane.terminal)) {
    return
  }
  ensureArabicShapingJoinerForText(pane.terminal, data)
  const guardCallbacks = engageReplayGuard(
    replayingPanesRef.current,
    pane.id,
    pane.terminal,
    options.stallCheckMs ?? REPLAY_GUARD_STALL_CHECK_MS
  )
  // Why: hidden/snapshot replay skips the foreground path; WebGL/canvas still need a post-parse repaint to drop stale cells.
  writeForegroundTerminalChunk(pane.terminal, data, {
    forceViewportRefresh: true,
    followupViewportRefresh: true,
    shouldRefreshViewportSynchronously: options.shouldRefreshViewportSynchronously,
    shouldReleaseRenderPause: options.shouldReleaseRenderPause,
    onParsed: guardCallbacks.onParsed,
    onWriteFailure: guardCallbacks.onWriteFailure
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
  // Why: same certified-dead short-circuit as replayIntoTerminal; resolve so awaited chains don't hang on a dead parser.
  if (isTerminalWritePipelineCertifiedDead(pane.terminal)) {
    return Promise.resolve()
  }
  ensureArabicShapingJoinerForText(pane.terminal, data)
  return new Promise((resolve) => {
    // Why resolve on either release path: callers await this; a lost completion must not hang the restore chain.
    const guardCallbacks = engageReplayGuard(
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
      shouldReleaseRenderPause: options.shouldReleaseRenderPause,
      onParsed: guardCallbacks.onParsed,
      onWriteFailure: guardCallbacks.onWriteFailure
    })
  })
}

/** Resolves once every replay write queued on this terminal has parsed. A delayed
 *  FIFO probe covers a lost sentinel without treating elapsed time as proof. */
export function waitForTerminalReplayWritesParsed(
  terminal: ReplayGuardWriteTarget,
  options: Pick<ReplayTerminalOptions, 'stallCheckMs'> = {}
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (finished) {
        return
      }
      finished = true
      if (stallTimer !== null) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
      resolve()
    }
    const queueProbe = (): void => {
      if (finished) {
        return
      }
      try {
        // Why: empty write is FIFO after replay bytes; its callback recovers a lost sentinel without changing parser state.
        terminal.write('', finish)
      } catch {
        // A disposed terminal cannot parse any remaining replay bytes.
        finish()
      }
    }
    stallTimer = setTimeout(queueProbe, options.stallCheckMs ?? REPLAY_GUARD_STALL_CHECK_MS)
    try {
      // Why empty: keep pendingEscapeTailAnsi as the final replay bytes; xterm still orders this completion after earlier writes.
      terminal.write('', finish)
    } catch {
      // A disposed terminal cannot parse any remaining replay bytes.
      finish()
    }
  })
}
