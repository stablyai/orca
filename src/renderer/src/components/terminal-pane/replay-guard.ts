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
import { writeXtermParseBarrier } from '@/lib/pane-manager/xterm-parse-barrier'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'

// Guard replay auto-replies from shell stdin while xterm’s provenance keeps real typing flowing.

export type ReplayingPanesRef = React.RefObject<Map<number, number>>

// Lost completions can latch input forever; certify stalls with a FIFO probe plus a fully quiet window, since blind timeout release could leak replies (#2836).
const REPLAY_GUARD_STALL_CHECK_MS = 10_000

type ReplayTerminalOptions = {
  breadcrumbIdentity?: {
    tabId?: string
    worktreeId?: string
    ptyId?: string | null
  }
  shouldRefreshViewportSynchronously?: () => boolean
  shouldReleaseRenderPause?: () => boolean
  stallCheckMs?: number
}

type ReplayGuardBreadcrumbData = {
  paneId: number
  tabIdHash?: string
  worktreeIdHash?: string
  leafIdHash?: string
  ptyId?: string
}

function hashReplayIdentity(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function replayGuardBreadcrumbData(
  pane: ManagedPane,
  identity: ReplayTerminalOptions['breadcrumbIdentity']
): ReplayGuardBreadcrumbData {
  const data: ReplayGuardBreadcrumbData = { paneId: pane.id }
  if (pane.leafId) {
    data.leafIdHash = hashReplayIdentity(pane.leafId)
  }
  if (identity?.tabId) {
    data.tabIdHash = hashReplayIdentity(identity.tabId)
  }
  if (identity?.worktreeId) {
    data.worktreeIdHash = hashReplayIdentity(identity.worktreeId)
  }
  if (identity?.ptyId) {
    data.ptyId = redactPtyIdForDiagnostics(identity.ptyId)
  }
  return data
}

export function isPaneReplaying(ref: ReplayingPanesRef, paneId: number): boolean {
  return (ref.current.get(paneId) ?? 0) > 0
}

type ReplayGuardWriteTarget = Pick<ManagedPane['terminal'], 'write'>
type ReplayGuardWriteCallbacks = {
  onParsed: () => void
  onWriteFailure: () => void
}

/** One write owns one counter settlement; parse completion or probe-certified failure releases it exactly once. */
function engageReplayGuard(
  map: Map<number, number>,
  paneId: number,
  terminal: ReplayGuardWriteTarget,
  stallCheckMs: number,
  breadcrumbData: ReplayGuardBreadcrumbData,
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
      recordRendererCrashBreadcrumb('terminal_replay_guard_lost_completion', breadcrumbData)
    } else if (reason === 'wedged') {
      console.error(
        `[terminal] replay guard released for pane ${paneId} — xterm rejected the replay write or its probe never parsed (undeliverable write pipeline; pane likely needs recovery)`
      )
      recordRendererCrashBreadcrumb('terminal_replay_guard_wedged_release', breadcrumbData)
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
      writeXtermParseBarrier(terminal, () => {
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

/** Replay with a per-write guard so nested writes suppress auto-replies through their own parse completions. */
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
    options.stallCheckMs ?? REPLAY_GUARD_STALL_CHECK_MS,
    replayGuardBreadcrumbData(pane, options.breadcrumbIdentity)
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
      replayGuardBreadcrumbData(pane, options.breadcrumbIdentity),
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

/** Wait for every queued replay parse; delayed FIFO probes cover lost sentinels without treating elapsed time alone as proof. */
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
        writeXtermParseBarrier(terminal, finish)
      } catch {
        // A disposed terminal cannot parse any remaining replay bytes.
        finish()
      }
    }
    stallTimer = setTimeout(queueProbe, options.stallCheckMs ?? REPLAY_GUARD_STALL_CHECK_MS)
    try {
      // Why empty: keep pendingEscapeTailAnsi as the final replay bytes; xterm still orders this completion after earlier writes.
      writeXtermParseBarrier(terminal, finish)
    } catch {
      // A disposed terminal cannot parse any remaining replay bytes.
      finish()
    }
  })
}
