export type ClaudePermissionModeOutcome = 'applied' | 'unavailable' | 'unknown'

/** Why the cycle stopped. Surfaced to the user because every failure here is
 *  invisible from the chat pane — the evidence lives in the terminal. */
export type ClaudePermissionModeCycleReason =
  | 'reached'
  | 'unreadable'
  | 'undelivered'
  | 'exhausted'
  | 'not-in-cycle'
  | 'cancelled'

export type ClaudePermissionModeCycleResult = {
  outcome: ClaudePermissionModeOutcome
  reason: ClaudePermissionModeCycleReason
  presses: number
  /** Modes observed in order, so a stuck or overshooting cycle is diagnosable. */
  observed: string[]
}

const DEFAULT_SETTLE_MS = 250
const DEFAULT_MAX_PRESSES = 6

/** Settle pause between presses, so the TUI can redraw before the next read. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Shift+Tab advances Claude's permission mode by one step per press — there is
 * no menu to parse, and which modes exist in the cycle varies per session
 * (bypass/auto are conditional). So press-and-observe instead of computing a
 * step count: read the current mode, press once if it isn't the target, and
 * repeat. Bounded by a max press count and by detecting a completed lap.
 */
export async function cycleClaudePermissionMode(args: {
  target: string
  readMode: () => Promise<string | null>
  /** Returns false when the write could not be delivered. */
  sendKey: (key: string) => boolean
  key: string
  settleMs?: number
  maxPresses?: number
  isCancelled?: () => boolean
}): Promise<ClaudePermissionModeCycleResult> {
  const settleMs = args.settleMs ?? DEFAULT_SETTLE_MS
  const maxPresses = args.maxPresses ?? DEFAULT_MAX_PRESSES
  const seen = new Set<string>()
  const observed: string[] = []
  let presses = 0

  const result = (
    outcome: ClaudePermissionModeOutcome,
    reason: ClaudePermissionModeCycleReason
  ): ClaudePermissionModeCycleResult => ({ outcome, reason, presses, observed })

  while (true) {
    // Never press blindly when the current mode can't be observed.
    const mode = await args.readMode()
    if (mode === null) {
      return result('unknown', 'unreadable')
    }
    observed.push(mode)
    if (mode === args.target) {
      return result('applied', 'reached')
    }
    if (presses >= maxPresses) {
      return result('unknown', 'exhausted')
    }
    // A repeat means a full lap completed without ever showing the target —
    // it isn't in this session's cycle (e.g. bypass without the launch flag).
    if (seen.has(mode)) {
      return result('unavailable', 'not-in-cycle')
    }
    seen.add(mode)
    if (args.isCancelled?.()) {
      return result('unknown', 'cancelled')
    }
    if (!args.sendKey(args.key)) {
      return result('unknown', 'undelivered')
    }
    presses += 1
    await delay(settleMs)
  }
}

/** Short, user-forwardable detail — the toast is the only place this surfaces. */
export function describeClaudePermissionModeCycle(
  target: string,
  result: ClaudePermissionModeCycleResult
): string {
  const trail = result.observed.length > 0 ? result.observed.join(' → ') : 'nothing'
  switch (result.reason) {
    case 'reached':
      return `Set to ${target}.`
    case 'unreadable':
      return 'Could not read the current mode from the terminal.'
    case 'undelivered':
      return `The terminal did not accept the keystroke (after ${result.presses}).`
    case 'exhausted':
      return `Gave up after ${result.presses} presses; saw ${trail}.`
    case 'not-in-cycle':
      return `${target} is not in this session's cycle; saw ${trail}.`
    case 'cancelled':
      return 'The mode change was cancelled.'
  }
}
