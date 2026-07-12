/**
 * Shared per-PTY terminal title side-effect tracking — the parser core behind
 * both the renderer transport (`createPtyOutputProcessor`) and main's
 * per-PTY tracker in `OrcaRuntimeService.onPtyData`.
 *
 * Why shared: docs/reference/terminal-side-effect-authority.md makes main the
 * side-effect parser for every PTY whose bytes transit local main. Title
 * semantics (all-titles ordering, cursor-agent literal drop, normalization,
 * stale-working-title clearing) must not drift between the two paths.
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

// Braille spinner frame glyphs (U+2800–U+28FF) — the decorative animation
// class agents rotate through while working. Mirrors the range
// clearWorkingIndicators strips in agent-detection.ts.
// eslint-disable-next-line no-control-regex -- intentional unicode range
const BRAILLE_SPINNER_RE = /[\u2800-\u28FF]/g

/**
 * Strip decorative braille spinner frame glyphs for change comparisons.
 * Two working titles that differ only by the animation frame (e.g.
 * "⠋ Cursor Agent" vs "⠙ Cursor Agent") compare equal after stripping —
 * the gate consumers use to avoid fan-out churn on spinner ticks.
 */
export function stripBrailleSpinnerGlyphs(title: string): string {
  return title.replace(BRAILLE_SPINNER_RE, '').trim()
}

/** Provenance for title/idle facts. `staleWorkingTitleClear` marks facts
 *  synthesized by the 3s stale-working-title timer rather than observed
 *  bytes — consumers must not treat them as genuine task completions. */
export type TerminalTitleFactMeta = {
  staleWorkingTitleClear?: boolean
}

export type TerminalTitleTrackerCallbacks = {
  /**
   * Fired once per observed OSC title, in byte order — including the
   * synthesized cleared title when the stale-working timer fires.
   */
  onTitle?: (normalizedTitle: string, rawTitle: string, meta?: TerminalTitleFactMeta) => void
  onAgentBecameIdle?: (title: string, meta?: TerminalTitleFactMeta) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  /**
   * Fired once per chunk containing a real BEL (OSC-aware, escape state kept
   * across chunks), after the chunk's title facts — the renderer drain order.
   */
  onBell?: () => void
  /**
   * Fired per complete OSC 133;D (chunk-boundary-safe) with the sequence's
   * best-effort exit code — mirrors the renderer terminal-command-lifecycle
   * semantics so the fact path drops stale agent rows exactly like byte mode.
   */
  onCommandFinished?: (bestEffortExitCode: number | null) => void
  /** Fired once per newly observed GitHub PR URL (chunk-boundary-safe,
   *  deduplicated per tracker like the renderer detector). */
  onPrLink?: (link: TerminalGitHubPRLink) => void
  /**
   * Fired per chunk containing a DECSET 2031 subscribe (chunk-boundary-safe).
   * Lets hidden-delivery-gated renderer views answer the color-scheme query
   * without byte access; the reply itself stays with the view.
   */
  onMode2031Subscribe?: () => void
}

export type TerminalTitleTracker = {
  /** Feed one raw PTY chunk; titles are applied synchronously in byte order. */
  handleChunk: (data: string, options?: { titleScanData?: string }) => void
  /**
   * Apply a main-fabricated OSC title/BEL frame (agent hook spinner frames).
   * Parsed statelessly — never through the chunk bell detector — so a
   * synthetic tick landing between two real chunks that split an OSC cannot
   * corrupt the cross-chunk escape state into phantom or swallowed bells.
   */
  applySyntheticTitleFrame: (frame: string) => void
  /**
   * Seed the last-known title for a tracker created mid-session (app relaunch
   * with persisted/snapshot titles). No-ops once any title has been observed
   * or seeded — live state always wins. Fires no callbacks.
   */
  seedInitialTitle: (rawTitle: string) => void
  /** Last title surfaced through onTitle, after normalization. */
  getLastNormalizedTitle: () => string | null
  /**
   * While suppressed, handleChunk skips the four transient-fact scanners
   * (bell/133/pr-link/2031) — a thinning transport holds scan authority for
   * this PTY and relays their facts itself; feeding the (possibly gapped)
   * delivered bytes here would mint phantom or duplicate facts. Title
   * processing is unaffected. Un-suppressing resets the scanners' cross-chunk
   * carry: their last-fed byte predates the gap.
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
  // Why: created only when a consumer exists (like the bell detector) so
  // headless serve never pays the per-chunk 133/URL scans.
  const commandFinishedScanner = onCommandFinished
    ? createOsc133CommandFinishedScanner(onCommandFinished)
    : null
  let prLinkDetector = onPrLink ? createTerminalGitHubPRLinkDetector() : null
  let transientFactScanningSuppressed = false
  // Why: a DECSET 2031 subscribe can be split across PTY chunks; carry a
  // bounded tail between chunks so split sequences still match.
  let mode2031ScanTail = ''
  // Why: seed both the emitted-title memory (stale-title probe) and the agent
  // tracker so a mid-session tracker behaves as if it had observed the pane's
  // last live title — parity with the renderer processor's seeding.
  let lastEmittedTitle: string | null =
    options.initialTitle !== undefined ? normalizeTerminalTitle(options.initialTitle) : null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  // Why: set while the stale timer's cleared title flows through the agent
  // tracker so the resulting idle callback carries timer provenance — the
  // renderer must not turn a stale clear into a task-complete notification.
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
    // Why: cursor-agent re-emits its bare native title many times per turn
    // while still working; letting it through would stomp Orca's synthesized
    // "⠋ Cursor Agent" spinner state back to agentless within a second.
    if (isCursorNativeAgentTitle(rawTitle)) {
      return
    }
    lastEmittedTitle = normalizeTerminalTitle(rawTitle)
    onTitle?.(lastEmittedTitle, rawTitle)
    agentTracker?.handleTitle(rawTitle)
  }

  function handleChunk(data: string, options: { titleScanData?: string } = {}): void {
    const titleScanData = options.titleScanData ?? data
    // Why: this is main's per-chunk hot path — scan for the OSC introducer
    // once and share the result with the bell detector's fast-path gate.
    const containsOscIntroducer = data.includes('\x1b]')
    // Why: the bell detector must consume EVERY chunk so OSC sequences that
    // span chunk boundaries keep their escape state, even when the chunk has
    // no title. The fact itself is surfaced after the chunk's titles, the
    // renderer drain's order (payloads → titles → bell). While suppressed it
    // must consume NONE: the delivered bytes may be gapped.
    const containsBell =
      bellDetector && !transientFactScanningSuppressed
        ? bellDetector.chunkContainsBell(data, { containsOscIntroducer })
        : false
    // Why: feed EVERY OSC title in the chunk in byte order, never just the
    // last one. node-pty plus the main-process batch window commonly coalesce
    // multiple title updates into a single payload; a last-title reader drops
    // intra-chunk working→idle transitions (issue #1083).
    const titles = titleScanData.includes('\x1b]') ? extractAllOscTitles(titleScanData) : []
    if (titles.length > 0) {
      clearStaleTitleTimer()
      for (const title of titles) {
        applyObservedTitle(title)
      }
    } else if (
      // Why: agents that exit without resetting their title leave a stale
      // working spinner behind. Any title-less output while the last title
      // classifies as working restarts a 3s timer that rewrites the title to
      // its cleared form — the renderer transport's stale-title semantics.
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
          // Why: tag timer-synthesized facts. Main's timer is unthrottled
          // (unlike the renderer timers that previously damped this path in
          // hidden windows), so a merely-paused agent must be distinguishable
          // from a genuine working→idle completion downstream.
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
    // Per-chunk fact order: titles → command-finished → pr-link →
    // 2031-subscribe → bell. The bell stays last (the renderer drain's
    // order); the byte scanners keep their own cross-chunk carry so split
    // sequences/URLs still resolve.
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
    // Why: synthetic frames have an exact main-fabricated shape, so they are
    // parsed statelessly here. Feeding them through handleChunk would run the
    // stateful bell detector: a tick landing while a REAL OSC is split across
    // two chunks would consume the pending escape state, minting a phantom
    // bell from the continuation chunk or swallowing a real one.
    const titles = extractAllOscTitles(frame)
    if (titles.length > 0) {
      clearStaleTitleTimer()
      for (const title of titles) {
        applyObservedTitle(title)
      }
    }
    // The deliberate permission BEL rides outside the OSC title sequence. A
    // FRESH detector instance keeps the OSC-terminator-vs-bell semantics
    // while guaranteeing zero interaction with the chunk detector's state.
    // Synthetic frames never reach the 133/PR-link scanners: fabricated bytes
    // contain neither and must not perturb their cross-chunk carry state.
    if (onBell && createBellDetector().chunkContainsBell(frame)) {
      onBell()
    }
  }

  return {
    handleChunk,
    applySyntheticTitleFrame,
    seedInitialTitle(rawTitle: string): void {
      // Why: the cursor-agent literal drop applies to seeds too — restoring
      // the bare native title would stomp synthesized spinner state exactly
      // like emitting it live would.
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
        // Cross-chunk carry predates the suppressed (gapped) span — a stale
        // half-open OSC would swallow real bells; a stale 133/2031 tail or
        // URL fragment would mint phantom facts. The PR-link dedup memory is
        // lost with the recreate; a re-printed link may re-fire (consumers
        // treat pr-link as a latest-association update).
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
