import {
  presentAllTerminalPanesWithoutAtlasClear,
  resetAndRefreshAllTerminalWebglAtlases
} from '@/lib/pane-manager/pane-manager-registry'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]

// Why: a streaming TUI requests output atlas recovery every frame; recovering
// mid-stream clears the shared atlas and repaints every pane, which flickers
// (STA-1365). Wait for output to go quiet so recovery runs once, on settle.
export const TERMINAL_OUTPUT_RECOVERY_QUIET_MS = 200

// Why: the debounce bounds nothing against a TUI redrawing just slower than the
// quiet window — every parse then trips the trailing edge. Field bundle
// F0BMLFAFWF7 recorded 442 shared-atlas wipes in 6.2 min (~1/s, sustained for
// hours). Bound how often the streaming path may escalate to a wipe; over-budget
// settles present from the live buffers instead.
const TERMINAL_OUTPUT_RECOVERY_MIN_INTERVAL_MS = 3_000
// Why: a token bucket, not a fixed-window count. A count over a rolling 60s
// window burns its whole allowance in the first 30s of a sustained stream and
// then starves for 33s, and the only recovery left in that hole is a buffer
// re-present, which never rebuilds the glyph atlas — so vim-style rewrites stay
// garbled for half a minute. Refilling continuously keeps the same sustained
// ceiling while degrading the worst-case wipe gap to the refill interval.
const TERMINAL_OUTPUT_RECOVERY_BURST_WIPES = 10
const TERMINAL_OUTPUT_RECOVERY_REFILL_INTERVAL_MS = 6_000

let terminalOutputRecoveryDebounceTimer: ReturnType<typeof setTimeout> | null = null
let terminalOutputRecoveryWipeTokens = TERMINAL_OUTPUT_RECOVERY_BURST_WIPES
let terminalOutputRecoveryTokensRefilledAt: number | null = null
let terminalOutputRecoveryLastWipeAt: number | null = null

function scheduleNextFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(callback)
    return
  }
  globalThis.setTimeout(callback, 0)
}

function resetAtlasesAndRefreshPanes(): void {
  try {
    // Why: the glyph atlas is shared across same-config terminals, so the
    // recovery reset must be followed by repainting each rebuilt render model.
    resetAndRefreshAllTerminalWebglAtlases()
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

function scheduleAtlasRecoveryBurst(): void {
  scheduleNextFrame(() => resetAtlasesAndRefreshPanes())
  for (const delayMs of ATLAS_RECOVERY_DELAYS_MS) {
    globalThis.setTimeout(() => resetAtlasesAndRefreshPanes(), delayMs)
  }
}

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Why: image chips can redraw after bracketed paste parsing, so cover the
  // short post-paste paint window with a few cheap atlas rebuilds. Paste is a
  // one-shot event, so recover immediately rather than debouncing.
  scheduleAtlasRecoveryBurst()
}

export function scheduleTabRevealWebglAtlasRecovery(): void {
  // Why: a tab reveal is one-shot, so recover immediately — decoupled from the
  // streaming debounce so a background stream can't defer a revealed tab's rebuild.
  scheduleAtlasRecoveryBurst()
}

export function scheduleTerminalWebglAtlasRecovery(): void {
  // Why: terminal-output recovery (foreground + hidden PTY writes). Trailing-edge
  // debounce so a clear only ever runs after 200ms of quiet — never mid-stream;
  // a resumed stream cancels the pending timer, so a pause-then-resume can't leak.
  if (terminalOutputRecoveryDebounceTimer != null) {
    globalThis.clearTimeout(terminalOutputRecoveryDebounceTimer)
  }
  terminalOutputRecoveryDebounceTimer = globalThis.setTimeout(() => {
    terminalOutputRecoveryDebounceTimer = null
    if (consumeTerminalOutputRecoveryWipeBudget()) {
      resetAtlasesAndRefreshPanes()
      return
    }
    presentPanesWithoutAtlasClear()
  }, TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
}

// Test seam: the wipe budget is module-global, so a suite of scheduler tests
// would otherwise inherit the previous test's spent budget.
export function resetTerminalWebglAtlasRecoveryBudgetForTesting(): void {
  terminalOutputRecoveryWipeTokens = TERMINAL_OUTPUT_RECOVERY_BURST_WIPES
  terminalOutputRecoveryTokensRefilledAt = null
  terminalOutputRecoveryLastWipeAt = null
}

function refillTerminalOutputRecoveryWipeTokens(now: number): void {
  const elapsedMs = now - (terminalOutputRecoveryTokensRefilledAt ?? now)
  terminalOutputRecoveryTokensRefilledAt = now
  // Why: wall-clock can step backwards (NTP, system sleep, VM resume); treat that
  // as a fresh bucket so recovery can't wedge until the clock catches up.
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

function consumeTerminalOutputRecoveryWipeBudget(): boolean {
  const now = Date.now()
  refillTerminalOutputRecoveryWipeTokens(now)
  if (
    terminalOutputRecoveryLastWipeAt != null &&
    now - terminalOutputRecoveryLastWipeAt < TERMINAL_OUTPUT_RECOVERY_MIN_INTERVAL_MS
  ) {
    return false
  }
  if (terminalOutputRecoveryWipeTokens < 1) {
    return false
  }
  terminalOutputRecoveryWipeTokens -= 1
  terminalOutputRecoveryLastWipeAt = now
  return true
}
