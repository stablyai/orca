/** Share title semantics between renderer transport processing and main’s per-PTY side-effect tracker. */

import {
  type AgentStatus,
  type AgentIdleStatus,
  clearWorkingIndicators,
  createAgentStatusTracker,
  detectAgentStatusFromTitle,
  extractAllOscTitles,
  isCursorNativeAgentTitle,
  normalizeTerminalTitle,
  shouldSuppressCursorNativeTitle
} from './agent-detection'
import type { ProgramActivityChange } from './agent-status-osc'
import { extractAllOscTitleEntries } from './osc-title-extraction'
import { placeProgramActivityAmongTitles } from './program-status/title-activity-order'
import { createBellDetector } from './terminal-bell-detector'
import {
  INITIAL_MODE_2031_REPLY_SCAN_STATE,
  scanMode2031ReplyDecision
} from './terminal-color-scheme-protocol'
import {
  createTerminalGitHubPRLinkDetector,
  type TerminalGitHubPRLink
} from './terminal-github-pr-link-detector'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

/** Ms of title-less output after a working title before it is cleared. */
export const STALE_WORKING_TITLE_TIMEOUT_MS = 3000

/** Provenance for title/idle facts; `staleWorkingTitleClear` marks facts synthesized by the 3s stale timer — not genuine task completions. */
export type TerminalTitleFactMeta = {
  staleWorkingTitleClear?: boolean
}

/** An idle edge's provenance plus the status the tracker classified, so readers need not re-read the title. */
export type AgentIdleEdgeMeta = TerminalTitleFactMeta & { status?: AgentIdleStatus }

type TerminalTitleTrackerChunkOptions = {
  titleScanData?: string
  mode2031PendingSubscribe?: boolean
  /** The chunk's OSC 7501 activity changes, offsets in `data`; applied in byte order with its titles. */
  programActivity?: readonly ProgramActivityChange[]
}

export type TerminalTitleTrackerCallbacks = {
  /** Fired once per observed OSC title, in byte order — including the synthesized cleared title when the stale-working timer fires. */
  onTitle?: (normalizedTitle: string, rawTitle: string, meta?: TerminalTitleFactMeta) => void
  onAgentBecameIdle?: (title: string, meta?: AgentIdleEdgeMeta) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  /** Fired per change in the program's OSC 7501 activity (see applyProgramActivity). */
  onProgramActivity?: (activity: AgentStatus | null) => void
  /** Fired once per chunk containing a real BEL (OSC-aware, cross-chunk escape state), after the chunk's titles (renderer drain order). */
  onBell?: () => void
  /** Complete OSC 133;D with best-effort exit code; fact and byte paths must retire stale agent rows alike. */
  onCommandFinished?: (bestEffortExitCode: number | null) => void
  /** Fired per complete OSC 133;C: the shell exec'd a command, so the pane's foreground changed. */
  onCommandStarted?: () => void
  /** Fired once per newly observed GitHub PR URL (chunk-boundary-safe, deduplicated per tracker). */
  onPrLink?: (link: TerminalGitHubPRLink) => void
  /** Report the chunk-final subscription so hidden views can track it without receiving bytes. */
  onMode2031Subscribe?: () => void
  /** Report chunk-final withdrawal; gated views miss its bytes and would otherwise push theme replies into an unsubscribed shell (#9993). */
  onMode2031Unsubscribe?: () => void
}

export type TerminalTitleTracker = {
  /** Feed one raw PTY chunk; titles are applied synchronously in byte order. */
  handleChunk: (data: string, options?: TerminalTitleTrackerChunkOptions) => void
  /** Parse fabricated spinner title/BEL frames statelessly so they cannot corrupt real cross-chunk escapes. */
  applySyntheticTitleFrame: (frame: string) => void
  /** Seed a mid-session tracker once without callbacks; observed/seeded live state wins. */
  seedInitialTitle: (rawTitle: string) => void
  /** The stream lost the program's OSC 7501 reports (a data gap): titles classify again. */
  endProgramActivity: () => void
  /** Restore the status consumed by the latest exit candidate when process evidence disproves it. */
  restoreLastAgentExit: (confirmedStatus?: AgentStatus) => AgentStatus | null
  /** Last title surfaced through onTitle, after normalization. */
  getLastNormalizedTitle: () => string | null
  /** A thinning transport owns transient scans while bytes may be gapped. Keep title scans; reset transient carries when authority returns. */
  setTransientFactScanningSuppressed: (suppressed: boolean) => void
  /** Enable consumer-only bell, PR-link, and mode-2031 scans without resetting title state. */
  setTransientSideEffectScanningEnabled: (enabled: boolean) => void
  /** Cancel the stale-title timer and clear accumulated tracker state. */
  dispose: () => void
}

export function createTerminalTitleTracker(
  callbacks: TerminalTitleTrackerCallbacks,
  options: { initialTitle?: string } = {}
): TerminalTitleTracker {
  const {
    onTitle,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onProgramActivity,
    onBell,
    onCommandFinished,
    onCommandStarted,
    onPrLink,
    onMode2031Subscribe,
    onMode2031Unsubscribe
  } = callbacks
  let bellDetector = onBell ? createBellDetector() : null
  // Allocate scanners only for consumers so headless serve avoids per-chunk 133/URL scans.
  const commandFinishedScanner =
    onCommandFinished || onCommandStarted
      ? createOsc133CommandFinishedScanner(
          (exitCode) => onCommandFinished?.(exitCode),
          onCommandStarted ? () => onCommandStarted() : undefined
        )
      : null
  let prLinkDetector = onPrLink ? createTerminalGitHubPRLinkDetector() : null
  let transientSideEffectScanningEnabled = true
  let transientFactScanningSuppressed = false
  let mode2031ReplyScanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
  // Seed both title forms to match a tracker that observed the last live title.
  let lastEmittedTitle: string | null =
    options.initialTitle !== undefined ? normalizeTerminalTitle(options.initialTitle) : null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  // Timer clears are provenance-tagged so silence cannot become a task completion.
  let applyingStaleWorkingTitleClear = false
  const initialAgentStatusTitle =
    options.initialTitle !== undefined && !isCursorNativeAgentTitle(options.initialTitle)
      ? options.initialTitle
      : undefined
  const agentTracker =
    onAgentBecameIdle || onAgentBecameWorking || onAgentExited
      ? createAgentStatusTracker(
          (title, status) => {
            onAgentBecameIdle?.(title, {
              status,
              ...(applyingStaleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
            })
          },
          onAgentBecameWorking,
          onAgentExited,
          initialAgentStatusTitle
        )
      : null

  function clearStaleTitleTimer(): void {
    if (staleTitleTimer) {
      clearTimeout(staleTitleTimer)
      staleTitleTimer = null
    }
  }

  function applyObservedTitle(rawTitle: string): void {
    // Why: cursor-agent re-emits its bare native title mid-turn; passing it through would stomp Orca's synthesized spinner state.
    if (isCursorNativeAgentTitle(rawTitle)) {
      if (shouldSuppressCursorNativeTitle(lastEmittedTitle)) {
        return
      }
      // Hookless Cursor needs its literal identity once; null status must not be interpreted as an agent exit (#10258).
      lastEmittedTitle = normalizeTerminalTitle(rawTitle)
      onTitle?.(lastEmittedTitle, rawTitle)
      return
    }
    lastEmittedTitle = normalizeTerminalTitle(rawTitle)
    onTitle?.(lastEmittedTitle, rawTitle)
    agentTracker?.handleTitle(rawTitle)
  }

  function applyProgramActivity(activity: AgentStatus | null): void {
    agentTracker?.handleProgramActivity(activity)
    onProgramActivity?.(activity)
  }

  function handleChunk(data: string, options: TerminalTitleTrackerChunkOptions = {}): void {
    const titleScanData = options.titleScanData ?? data
    // Why: hot path — scan for the OSC introducer once and share it with the bell detector's fast-path gate.
    const containsOscIntroducer = data.includes('\x1b]')
    // Feed every contiguous chunk to preserve OSC state; suppressed bytes may be gapped.
    const containsBell =
      bellDetector && !transientFactScanningSuppressed
        ? bellDetector.chunkContainsBell(data, { containsOscIntroducer })
        : false
    // Process every title in byte order or coalescing hides working → idle transitions (#1083).
    const titles = titleScanData.includes('\x1b]') ? extractAllOscTitleEntries(titleScanData) : []
    // Title ends move into `data`'s offsets: titleScanData is the previous scan tail plus `data`.
    const tailLength = titleScanData.length - data.length
    const activity = options.programActivity
      ? placeProgramActivityAmongTitles(
          titles.map((entry) => entry.end - tailLength),
          options.programActivity
        )
      : []
    let activityIndex = 0
    const applyActivityBefore = (titleIndex: number): void => {
      while (activityIndex < activity.length && activity[activityIndex].beforeTitle <= titleIndex) {
        applyProgramActivity(activity[activityIndex].activity)
        activityIndex += 1
      }
    }
    if (titles.length > 0) {
      clearStaleTitleTimer()
      titles.forEach((entry, index) => {
        applyActivityBefore(index)
        applyObservedTitle(entry.title)
      })
    }
    applyActivityBefore(titles.length)
    if (
      titles.length === 0 &&
      // Why: an agent exiting without resetting its title leaves a stale spinner; title-less output while working arms the 3s clear timer.
      data.length > 0 &&
      lastEmittedTitle !== null &&
      detectAgentStatusFromTitle(lastEmittedTitle) === 'working'
    ) {
      clearStaleTitleTimer()
      staleTitleTimer = setTimeout(() => {
        staleTitleTimer = null
        if (lastEmittedTitle && detectAgentStatusFromTitle(lastEmittedTitle) === 'working') {
          const cleared = clearWorkingIndicators(lastEmittedTitle)
          lastEmittedTitle = cleared
          // Why: tag timer-synthesized facts so downstream distinguishes a merely-paused agent from a genuine working→idle completion.
          applyingStaleWorkingTitleClear = true
          try {
            onTitle?.(cleared, cleared, { staleWorkingTitleClear: true })
            agentTracker?.handleTitle(cleared)
          } finally {
            applyingStaleWorkingTitleClear = false
          }
        }
      }, STALE_WORKING_TITLE_TIMEOUT_MS)
    }
    // Fact order (matches renderer drain): titles → command-finished → pr-link → 2031-subscribe → bell; bell last.
    if (!transientFactScanningSuppressed) {
      commandFinishedScanner?.scan(data)
      if (prLinkDetector) {
        for (const link of prLinkDetector(data)) {
          onPrLink?.(link)
        }
      }
      if (transientSideEffectScanningEnabled && (onMode2031Subscribe || onMode2031Unsubscribe)) {
        const previousMode2031ReplyScanState = options.mode2031PendingSubscribe
          ? { ...mode2031ReplyScanState, pendingSubscribe: true }
          : mode2031ReplyScanState
        const result = scanMode2031ReplyDecision(previousMode2031ReplyScanState, data)
        mode2031ReplyScanState = result.state
        if (result.decision === 'subscribed') {
          onMode2031Subscribe?.()
        } else if (result.decision === 'unsubscribed') {
          onMode2031Unsubscribe?.()
        }
      }
    }
    if (containsBell) {
      onBell?.()
    }
  }

  function applySyntheticTitleFrame(frame: string): void {
    // Stateless parsing cannot mint/swallow bells around a real split OSC.
    const titles = extractAllOscTitles(frame)
    if (titles.length > 0) {
      clearStaleTitleTimer()
      for (const title of titles) {
        applyObservedTitle(title)
      }
    }
    // Use a fresh bell detector for the permission BEL outside the fabricated title.
    if (
      transientSideEffectScanningEnabled &&
      onBell &&
      createBellDetector().chunkContainsBell(frame)
    ) {
      onBell()
    }
    // Skip transient scanners: fabricated titles must not disturb their real-stream carry.
  }

  return {
    handleChunk,
    applySyntheticTitleFrame,
    endProgramActivity: () => applyProgramActivity(null),
    seedInitialTitle(rawTitle: string): void {
      if (lastEmittedTitle !== null || !rawTitle) {
        return
      }
      lastEmittedTitle = normalizeTerminalTitle(rawTitle)
      // Cursor’s literal seeds identity only; null status would make the next real frame look like an exit.
      if (!isCursorNativeAgentTitle(rawTitle)) {
        agentTracker?.seedTitle(rawTitle)
      }
    },
    restoreLastAgentExit(confirmedStatus?: AgentStatus): AgentStatus | null {
      return agentTracker?.restoreLastExit(confirmedStatus) ?? null
    },
    getLastNormalizedTitle: () => lastEmittedTitle,
    setTransientFactScanningSuppressed(suppressed: boolean): void {
      if (suppressed === transientFactScanningSuppressed) {
        return
      }
      transientFactScanningSuppressed = suppressed
      if (!suppressed) {
        // Cross-chunk carry predates the gapped span; reset it so stale state can't swallow real bells or mint phantom facts.
        bellDetector?.reset()
        commandFinishedScanner?.reset()
        mode2031ReplyScanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
        if (prLinkDetector) {
          prLinkDetector = createTerminalGitHubPRLinkDetector()
        }
      }
    },
    setTransientSideEffectScanningEnabled(enabled: boolean): void {
      if (enabled === transientSideEffectScanningEnabled) {
        return
      }
      transientSideEffectScanningEnabled = enabled
      bellDetector?.reset()
      bellDetector = enabled && onBell ? createBellDetector() : null
      prLinkDetector = enabled && onPrLink ? createTerminalGitHubPRLinkDetector() : null
      mode2031ReplyScanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
    },
    dispose(): void {
      clearStaleTitleTimer()
      agentTracker?.reset()
      bellDetector?.reset()
      commandFinishedScanner?.reset()
      mode2031ReplyScanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
    }
  }
}
