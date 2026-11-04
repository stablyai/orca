import {
  usageLimitResetsAt,
  type AgentSessionUsageLimit,
  type AgentSessionUsageLimitWindow
} from './agent-session-usage-limit'

const CLAUDE_LIMIT_WINDOWS = new Map<string, AgentSessionUsageLimitWindow>([
  ['five_hour', 'session'],
  ['seven_day', 'weekly'],
  ['seven_day_opus', 'weeklyModel'],
  ['seven_day_sonnet', 'weeklyModel'],
  ['seven_day_overage_included', 'weeklyModel'],
  ['overage', 'credits']
])

export function claudeUsageLimitWindow(type: string): AgentSessionUsageLimitWindow | undefined {
  return CLAUDE_LIMIT_WINDOWS.get(type)
}

type CodexUsageLimitWindow = {
  usedPercent?: unknown
  windowDurationMins?: unknown
  resetsAt?: unknown
}

export type CodexUsageLimitSnapshot = {
  primary?: CodexUsageLimitWindow | null
  secondary?: CodexUsageLimitWindow | null
  rateLimitReachedType?: unknown
  planType?: unknown
}

/** All spent windows must reset; report the latest only if every reset is known. */
export function codexUsageLimit(
  snapshot: CodexUsageLimitSnapshot,
  now: number
): AgentSessionUsageLimit | null {
  const monthlyPlan = snapshot.planType === 'free' || snapshot.planType === 'go'
  const spent = (
    [
      ['primary', monthlyPlan ? 43200 : 300],
      ['secondary', 10080]
    ] as const
  ).flatMap(([position, fallback]) => {
    const raw = snapshot[position]
    if (
      !raw ||
      typeof raw.usedPercent !== 'number' ||
      !Number.isFinite(raw.usedPercent) ||
      raw.usedPercent < 100
    ) {
      return []
    }
    const duration =
      raw.windowDurationMins === undefined || raw.windowDurationMins === null
        ? fallback
        : raw.windowDurationMins
    const window =
      typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? duration >= 43200
          ? undefined
          : duration >= 10080
            ? ('weekly' as const)
            : ('session' as const)
        : undefined
    return [{ window, resetsAt: raw.resetsAt }]
  })
  const reached = snapshot.rateLimitReachedType
  const credits = typeof reached === 'string' && reached.endsWith('credits_depleted')
  const window: AgentSessionUsageLimitWindow | undefined = credits
    ? 'credits'
    : spent.length === 1
      ? spent[0]?.window
      : undefined
  const resets = spent.flatMap((entry) =>
    typeof entry.resetsAt === 'number' ? [entry.resetsAt * 1000] : []
  )
  const resetsAt =
    resets.length > 0 && resets.length === spent.length
      ? usageLimitResetsAt(Math.max(...resets), now)
      : undefined
  return window || resetsAt
    ? { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
    : null
}
