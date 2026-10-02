export const CLAUDE_COMPACT_METRICS = ['auto', 'session', 'weekly', 'fableWeekly'] as const

export type ClaudeCompactMetric = (typeof CLAUDE_COMPACT_METRICS)[number]
export type ExplicitClaudeCompactMetric = Exclude<ClaudeCompactMetric, 'auto'>

export const DEFAULT_CLAUDE_COMPACT_METRIC: ClaudeCompactMetric = 'auto'

export function normalizeClaudeCompactMetric(value: unknown): ClaudeCompactMetric {
  return value === 'auto' || value === 'session' || value === 'weekly' || value === 'fableWeekly'
    ? value
    : DEFAULT_CLAUDE_COMPACT_METRIC
}
