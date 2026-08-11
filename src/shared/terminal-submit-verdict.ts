// Why: a send that writes bytes into a PTY is not proof the agent received them. A completion
// popup can eat the Enter, or the TUI can be mid-turn, and the text then sits unsubmitted in the
// composer while the caller reads success. This is the vocabulary callers use to tell those apart.

/** Ordered from most to least evidence. */
export const TERMINAL_SUBMIT_VERDICT_STATUSES = [
  'submitted',
  'queued',
  'pending',
  'unknown'
] as const

export type TerminalSubmitVerdictStatus = (typeof TERMINAL_SUBMIT_VERDICT_STATUSES)[number]

export type TerminalSubmitVerdictReason =
  /** The harness reported a turn start for this pane after the write. */
  | 'turn-start-observed'
  /** The harness recorded the text as a user message while it was idle. */
  | 'message-accepted'
  /** The harness recorded the text as a user message while a turn was still running. */
  | 'accepted-mid-turn'
  /** The harness reports turn starts, was idle, and reported nothing within the bound. */
  | 'no-turn-start-observed'
  /** No live hook event has ever arrived for this pane in this runtime. */
  | 'no-live-hook-evidence'
  /** This harness exposes no semantic turn-start signal at all. */
  | 'harness-has-no-turn-start-signal'
  /** A turn was already running, so a silent bound tells us nothing. */
  | 'sent-mid-turn'
  /** The terminal handle has no stable pane identity to key hook events by. */
  | 'no-pane-identity'

export type TerminalSubmitVerdict = {
  status: TerminalSubmitVerdictStatus
  reason: TerminalSubmitVerdictReason
  /** Milliseconds spent waiting for harness evidence, across the retry when there was one. */
  waitedMs: number
  /** Set when Orca re-sent the submit key — never the text — after a `pending` verdict. */
  resubmitted?: true
}

export type TerminalSubmitVerdictRequest = {
  /** Bound on waiting for harness evidence; clamped by `clampTerminalSubmitVerdictTimeoutMs`. */
  timeoutMs?: number
  /** Re-send the submit key once on a `pending` verdict. Defaults to true. */
  retrySubmit?: boolean
}

/** Default bound on waiting for turn-start evidence. Turn-start hooks fire on submit, so the
 *  budget only has to cover hook transport (local, WSL relay, or SSH relay) plus TUI redraw. */
export const DEFAULT_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS = 2_500

/** Upper bound accepted from callers, so a request can never park an RPC worker indefinitely. */
export const MAX_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS = 120_000

export function clampTerminalSubmitVerdictTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS
  }
  // Why the 1ms floor: truncating a positive fractional bound (0.5) to 0 would skip the evidence
  // wait entirely and answer from the pre-write snapshot alone, which reads as a real verdict.
  return Math.min(Math.max(1, Math.trunc(timeoutMs)), MAX_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS)
}

/** The only status that means the agent took the text into a turn. A missing verdict is an old
 *  host that cannot answer, which is `unknown` — never success. */
export function isTerminalSubmitDelivered(verdict: TerminalSubmitVerdict | undefined): boolean {
  return verdict?.status === 'submitted'
}
