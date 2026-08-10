import {
  presentAllTerminalPanesWithoutAtlasClear,
  resetAndRefreshAllTerminalWebglAtlases
} from '@/lib/pane-manager/pane-manager-registry'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]

// Why: a streaming TUI requests output atlas recovery every frame; recovering
// mid-stream clears the shared atlas and repaints every pane, which flickers
// (STA-1365). Wait for output to go quiet so recovery runs once, on settle.
export const TERMINAL_OUTPUT_RECOVERY_QUIET_MS = 200

// Bound reset storms while preserving prompt recovery and steady repair attempts.
const TERMINAL_OUTPUT_RECOVERY_MIN_INTERVAL_MS = 3_000
const TERMINAL_OUTPUT_RECOVERY_BURST_WIPES = 10
const TERMINAL_OUTPUT_RECOVERY_REFILL_INTERVAL_MS = 6_000

let terminalOutputRecoveryDebounceTimer: ReturnType<typeof setTimeout> | null = null
let terminalOutputRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null
let terminalOutputRecoveryWipeTokens = TERMINAL_OUTPUT_RECOVERY_BURST_WIPES
let terminalOutputRecoveryTokensRefilledAt: number | null = null
let terminalOutputRecoveryLastWipeAt: number | null = null
let terminalOutputRecoveryAttemptsSinceLastWipe = 0
let terminalOutputRecoverySuppressedSinceLastWipe = 0

function scheduleNextFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(callback)
    return
  }
  globalThis.setTimeout(callback, 0)
}

function resetAtlasesAndRefreshPanes(reason: string): void {
  try {
    // Why: the glyph atlas is shared across same-config terminals, so the
    // recovery reset must be followed by repainting each rebuilt render model.
    resetAndRefreshAllTerminalWebglAtlases(reason)
  } catch {
    /* ignore - terminal pane may have unmounted after scheduling recovery */
  }
}

function presentPanesWithoutAtlasClear(): void {
  try {
    presentAllTerminalPanesWithoutAtlasClear()
  } catch {
    /* ignore - terminal pane may have unmounted after scheduling recovery */
  }
}

function scheduleAtlasRecoveryBurst(reason: string): void {
  scheduleNextFrame(() => resetAtlasesAndRefreshPanes(reason))
  for (const delayMs of ATLAS_RECOVERY_DELAYS_MS) {
    globalThis.setTimeout(() => resetAtlasesAndRefreshPanes(reason), delayMs)
  }
}

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Why: image chips can redraw after bracketed paste parsing, so cover the
  // short post-paste paint window with a few cheap atlas rebuilds. Paste is a
  // one-shot event, so recover immediately rather than debouncing.
  scheduleAtlasRecoveryBurst('image-paste')
}

export function scheduleTabRevealWebglAtlasRecovery(): void {
  // Why: a tab reveal is one-shot, so recover immediately — decoupled from the
  // streaming debounce so a background stream can't defer a revealed tab's rebuild.
  scheduleAtlasRecoveryBurst('tab-reveal')
}

export function scheduleTerminalWebglAtlasRecovery(): void {
  // Why: terminal-output recovery (foreground + hidden PTY writes). Trailing-edge
  // debounce so a clear only ever runs after 200ms of quiet — never mid-stream;
  // a resumed stream cancels the pending timer, so a pause-then-resume can't leak.
  if (terminalOutputRecoveryDebounceTimer != null) {
    globalThis.clearTimeout(terminalOutputRecoveryDebounceTimer)
  }
  if (terminalOutputRecoveryRetryTimer != null) {
    globalThis.clearTimeout(terminalOutputRecoveryRetryTimer)
    terminalOutputRecoveryRetryTimer = null
  }
  terminalOutputRecoveryDebounceTimer = globalThis.setTimeout(() => {
    terminalOutputRecoveryDebounceTimer = null
    terminalOutputRecoveryAttemptsSinceLastWipe += 1
    const decision = consumeTerminalOutputRecoveryWipeBudget()
    if (!decision.allowed) {
      terminalOutputRecoverySuppressedSinceLastWipe += 1
      presentPanesWithoutAtlasClear()
      scheduleTerminalOutputRecoveryRetry(decision.retryAfterMs)
      return
    }
    resetTerminalOutputAtlases(decision.intervalMs)
  }, TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
}

function scheduleTerminalOutputRecoveryRetry(delayMs: number): void {
  terminalOutputRecoveryRetryTimer = globalThis.setTimeout(() => {
    terminalOutputRecoveryRetryTimer = null
    const decision = consumeTerminalOutputRecoveryWipeBudget()
    if (!decision.allowed) {
      scheduleTerminalOutputRecoveryRetry(decision.retryAfterMs)
      return
    }
    resetTerminalOutputAtlases(decision.intervalMs)
  }, delayMs)
}

function resetTerminalOutputAtlases(intervalMs: number): void {
  recordTerminalWebglDiagnostic('webgl-atlas-reset-rate', {
    reason: 'terminal-output',
    attemptsSinceLastReset: terminalOutputRecoveryAttemptsSinceLastWipe,
    atlasResetsSuppressed: terminalOutputRecoverySuppressedSinceLastWipe,
    intervalMs
  })
  terminalOutputRecoveryAttemptsSinceLastWipe = 0
  terminalOutputRecoverySuppressedSinceLastWipe = 0
  resetAtlasesAndRefreshPanes('terminal-output')
}

export function resetTerminalWebglAtlasRecoveryBudgetForTesting(): void {
  if (terminalOutputRecoveryDebounceTimer != null) {
    globalThis.clearTimeout(terminalOutputRecoveryDebounceTimer)
  }
  terminalOutputRecoveryDebounceTimer = null
  if (terminalOutputRecoveryRetryTimer != null) {
    globalThis.clearTimeout(terminalOutputRecoveryRetryTimer)
  }
  terminalOutputRecoveryRetryTimer = null
  terminalOutputRecoveryWipeTokens = TERMINAL_OUTPUT_RECOVERY_BURST_WIPES
  terminalOutputRecoveryTokensRefilledAt = null
  terminalOutputRecoveryLastWipeAt = null
  terminalOutputRecoveryAttemptsSinceLastWipe = 0
  terminalOutputRecoverySuppressedSinceLastWipe = 0
}

function refillTerminalOutputRecoveryWipeTokens(now: number): void {
  const elapsedMs = now - (terminalOutputRecoveryTokensRefilledAt ?? now)
  terminalOutputRecoveryTokensRefilledAt = now
  // Sleep, NTP, and remote clock corrections must not wedge recovery.
  if (elapsedMs < 0) {
    terminalOutputRecoveryWipeTokens = TERMINAL_OUTPUT_RECOVERY_BURST_WIPES
    terminalOutputRecoveryLastWipeAt = null
    return
  }
  terminalOutputRecoveryWipeTokens = Math.min(
    TERMINAL_OUTPUT_RECOVERY_BURST_WIPES,
    terminalOutputRecoveryWipeTokens + elapsedMs / TERMINAL_OUTPUT_RECOVERY_REFILL_INTERVAL_MS
  )
}

function consumeTerminalOutputRecoveryWipeBudget(): {
  allowed: boolean
  intervalMs: number
  retryAfterMs: number
} {
  const now = Date.now()
  refillTerminalOutputRecoveryWipeTokens(now)
  const intervalMs =
    terminalOutputRecoveryLastWipeAt == null ? 0 : now - terminalOutputRecoveryLastWipeAt
  const intervalBudgetMs =
    terminalOutputRecoveryLastWipeAt == null
      ? 0
      : Math.max(0, TERMINAL_OUTPUT_RECOVERY_MIN_INTERVAL_MS - intervalMs)
  const tokenBudgetMs =
    terminalOutputRecoveryWipeTokens >= 1
      ? 0
      : (1 - terminalOutputRecoveryWipeTokens) * TERMINAL_OUTPUT_RECOVERY_REFILL_INTERVAL_MS
  const retryAfterMs = Math.ceil(Math.max(intervalBudgetMs, tokenBudgetMs))
  if (retryAfterMs > 0) {
    return { allowed: false, intervalMs, retryAfterMs }
  }
  terminalOutputRecoveryWipeTokens -= 1
  terminalOutputRecoveryLastWipeAt = now
  return { allowed: true, intervalMs, retryAfterMs: 0 }
}
