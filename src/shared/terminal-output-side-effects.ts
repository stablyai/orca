/**
 * Shared per-PTY terminal title side-effect tracking — the parser core behind both the renderer
 * transport (`createPtyOutputProcessor`) and main's per-PTY tracker (`OrcaRuntimeService.onPtyData`).
 * Title semantics must not drift between the two paths.
 */

import {
  clearWorkingIndicators,
  createAgentStatusTracker,
  detectAgentStatusFromTitle,
  extractAllOscTitles,
  isCursorNativeAgentTitle,
  normalizeTerminalTitle
} from './agent-detection'
import { createBellDetector } from './terminal-bell-detector'
import { scanMode2031Sequences } from './terminal-color-scheme-protocol'
import {
  createTerminalGitHubPRLinkDetector,
  type TerminalGitHubPRLink
} from './terminal-github-pr-link-detector'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

/** Ms of title-less output after a working title before it is cleared. */
export const STALE_WORKING_TITLE_TIMEOUT_MS = 3000

// Braille spinner glyphs (U+2800–U+28FF); mirrors the range clearWorkingIndicators strips in agent-detection.ts.
// eslint-disable-next-line no-control-regex -- intentional unicode range
const BRAILLE_SPINNER_RE = /[\u2800-\u28FF]/g

/**
 * Strip decorative braille spinner frame glyphs so titles differing only by the animation frame
 * compare equal — the gate consumers use to avoid fan-out churn on spinner ticks.
 */
export function stripBrailleSpinnerGlyphs(title: string): string {
  return title.replace(BRAILLE_SPINNER_RE, '').trim()
}

/** Provenance for title/idle facts; `staleWorkingTitleClear` marks facts synthesized by the 3s stale timer — not genuine task completions. */
export type TerminalTitleFactMeta = {
  staleWorkingTitleClear?: boolean
}

export type TerminalTitleTrackerCallbacks = {
  /** Fired once per observed OSC title, in byte order — including the synthesized cleared title when the stale-working timer fires. */
  onTitle?: (normalizedTitle: string, rawTitle: string, meta?: TerminalTitleFactMeta) => void
  onAgentBecameIdle?: (title: string, meta?: TerminalTitleFactMeta) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  /** Fired once per chunk containing a real BEL (OSC-aware, cross-chunk escape state), after the chunk's titles (renderer drain order). */
  onBell?: () => void
  /**
   * Fired per complete OSC 133;D (chunk-boundary-safe) with the sequence's best-effort exit code;
   * mirrors renderer command-lifecycle semantics so the fact path drops stale agent rows like byte mode.
   */
  onCommandFinished?: (bestEffortExitCode: number | null) => void
  /** Fired once per newly observed GitHub PR URL (chunk-boundary-safe, deduplicated per tracker). */
  onPrLink?: (link: TerminalGitHubPRLink) => void
  /**
   * Fired per chunk containing a DECSET 2031 subscribe (chunk-boundary-safe): lets
   * hidden-delivery-gated renderer views answer the color-scheme query without byte access.
   */
  onMode2031Subscribe?: () => void
}

export type TerminalTitleTracker = {
  /** Feed one raw PTY chunk; titles are applied synchronously in byte order. */
  handleChunk: (data: string, options?: { titleScanData?: string }) => void
  /**
   * Apply a main-fabricated OSC title/BEL frame (agent hook spinner frames). Parsed statelessly,
   * never through the chunk bell detector, so a synthetic tick can't corrupt cross-chunk escape state.
   */
  applySyntheticTitleFrame: (frame: string) => void
  /**
   * Seed the last-known title for a mid-session tracker (app relaunch with persisted titles).
   * No-ops once any title has been observed or seeded (live state wins); fires no callbacks.
   */
  seedInitialTitle: (rawTitle: string) => void
  /** Last title surfaced through onTitle, after normalization. */
  getLastNormalizedTitle: () => string | null
  /**
   * While suppressed, handleChunk skips the transient-fact scanners (bell/133/pr-link/2031)
   * because a thinning transport owns scan authority and the delivered bytes may be gapped.
   * Titles are unaffected; un-suppressing resets the scanners' cross-chunk carry.
   */
  setTransientFactScanningSuppressed: (suppressed: boolean) => void
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
    onBell,
    onCommandFinished,
    onPrLink,
    onMode2031Subscribe
  } = callbacks
  const bellDetector = onBell ? createBellDetector() : null
  // Why: created only when a consumer exists so headless serve never pays the per-chunk 133/URL scans.
  const commandFinishedScanner = onCommandFinished
    ? createOsc133CommandFinishedScanner(onCommandFinished)
    : null
  let prLinkDetector = onPrLink ? createTerminalGitHubPRLinkDetector() : null
  let transientFactScanningSuppressed = false
  // Why: a DECSET 2031 subscribe can split across chunks; carry a bounded tail so split sequences still match.
  let mode2031ScanTail = ''
  // Why: seed both so a mid-session tracker behaves as if it had observed the pane's last live title (renderer parity).
  let lastEmittedTitle: string | null =
    options.initialTitle !== undefined ? normalizeTerminalTitle(options.initialTitle) : null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  // Why: flags the stale-timer clear so its idle callback carries timer provenance, not a genuine task-complete.
  let applyingStaleWorkingTitleClear = false
  const agentTracker =
    onAgentBecameIdle || onAgentBecameWorking || onAgentExited
      ? createAgentStatusTracker(
          (title) => {
            onAgentBecameIdle?.(
              title,
              applyingStaleWorkingTitleClear ? { staleWorkingTitleClear: true } : undefined
            )
          },
          onAgentBecameWorking,
          onAgentExited,
          options.initialTitle
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
      return
    }
    lastEmittedTitle = normalizeTerminalTitle(rawTitle)
    onTitle?.(lastEmittedTitle, rawTitle)
    agentTracker?.handleTitle(rawTitle)
  }

  function handleChunk(data: string, options: { titleScanData?: string } = {}): void {
    const titleScanData = options.titleScanData ?? data
    // Why: hot path — scan for the OSC introducer once and share it with the bell detector's fast-path gate.
    const containsOscIntroducer = data.includes('\x1b]')
    // Why: consume every chunk so cross-chunk OSC escape state survives; but none while suppressed, since delivered bytes may be gapped.
    const containsBell =
      bellDetector && !transientFactScanningSuppressed
        ? bellDetector.chunkContainsBell(data, { containsOscIntroducer })
        : false
    // Why: feed every OSC title in byte order; a last-title reader drops intra-chunk working→idle transitions in coalesced payloads (issue #1083).
    const titles = titleScanData.includes('\x1b]') ? extractAllOscTitles(titleScanData) : []
    if (titles.length > 0) {
      clearStaleTitleTimer()
      for (const title of titles) {
        applyObservedTitle(title)
      }
    } else if (
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
      if (onMode2031Subscribe) {
        const mode2031Scan = scanMode2031Sequences(mode2031ScanTail, data)
        mode2031ScanTail = mode2031Scan.tail
        if (mode2031Scan.subscribe) {
          onMode2031Subscribe()
        }
      }
    }
    if (containsBell) {
      onBell?.()
    }
  }

  function applySyntheticTitleFrame(frame: string): void {
    // Why: parse statelessly — the stateful chunk bell detector could mint or swallow bells around a real cross-chunk OSC split.
    const titles = extractAllOscTitles(frame)
    if (titles.length > 0) {
      clearStaleTitleTimer()
      for (const title of titles) {
        applyObservedTitle(title)
      }
    }
    // The permission BEL rides outside the OSC title; a FRESH detector avoids touching the chunk detector's cross-chunk escape state.
    if (onBell && createBellDetector().chunkContainsBell(frame)) {
      onBell()
    }
    // Why: deliberately skip the 133/PR-link/2031 scanners — fabricated bytes contain none and must not perturb their cross-chunk carry.
  }

  return {
    handleChunk,
    applySyntheticTitleFrame,
    seedInitialTitle(rawTitle: string): void {
      // Why: the cursor-agent literal drop applies to seeds too — a bare native title would stomp synthesized spinner state.
      if (lastEmittedTitle !== null || !rawTitle || isCursorNativeAgentTitle(rawTitle)) {
        return
      }
      lastEmittedTitle = normalizeTerminalTitle(rawTitle)
      agentTracker?.seedTitle(rawTitle)
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
        mode2031ScanTail = ''
        if (prLinkDetector) {
          prLinkDetector = createTerminalGitHubPRLinkDetector()
        }
      }
    },
    dispose(): void {
      clearStaleTitleTimer()
      agentTracker?.reset()
      bellDetector?.reset()
      commandFinishedScanner?.reset()
      mode2031ScanTail = ''
    }
  }
}
