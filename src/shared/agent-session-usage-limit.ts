// Which of the agent's usage limits a turn hit and when it resets, as the provider reported it.
// Carried on a `usageLimitReached` failure fact; every reader words it in its own clock.

/** `session`: the rolling few-hour limit. `weekly`: the account's weekly limit. `weeklyModel`: a
 *  weekly limit on one model. `credits`: paid usage beyond the plan ran out. */
export const AGENT_SESSION_USAGE_LIMIT_WINDOWS = [
  'session',
  'weekly',
  'weeklyModel',
  'credits'
] as const
export type AgentSessionUsageLimitWindow = (typeof AGENT_SESSION_USAGE_LIMIT_WINDOWS)[number]

export type AgentSessionUsageLimit = {
  window?: AgentSessionUsageLimitWindow
  /** Epoch ms. Absent when the provider gave none, or any limit it hit had none. */
  resetsAt?: number
}

/** Past this, a reset time is not one a person waits for, so the words leave it out. */
const MAX_RESET_WAIT_MS = 31 * 24 * 60 * 60 * 1000

/** A reset time worth saying, as epoch ms: finite, positive and within a month of `now`. */
export function usageLimitResetsAt(value: unknown, now: number): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value - now <= MAX_RESET_WAIT_MS
    ? value
    : undefined
}

/** A limit as a reader meets it; undefined when it names nothing this build knows. */
export function readAgentSessionUsageLimit(value: unknown): AgentSessionUsageLimit | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record: Record<string, unknown> = { ...value }
  const window = AGENT_SESSION_USAGE_LIMIT_WINDOWS.find((known) => known === record.window)
  const resetsAt =
    typeof record.resetsAt === 'number' && Number.isFinite(record.resetsAt) && record.resetsAt > 0
      ? record.resetsAt
      : undefined
  return window || resetsAt
    ? { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
    : undefined
}

/** A reset time in the reader's own clock: the time alone today, else with its day. */
export function formatUsageLimitResetClock(resetsAt: number, now: number = Date.now()): string {
  const at = new Date(resetsAt)
  const today = at.toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(
    undefined,
    today
      ? { hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  ).format(at)
}
