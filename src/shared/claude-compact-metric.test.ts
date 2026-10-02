import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLAUDE_COMPACT_METRIC,
  normalizeClaudeCompactMetric
} from './claude-compact-metric'

describe('normalizeClaudeCompactMetric', () => {
  it.each(['auto', 'session', 'weekly', 'fableWeekly'] as const)('keeps %s', (value) => {
    expect(normalizeClaudeCompactMetric(value)).toBe(value)
  })

  it.each([undefined, null, '', 'monthly', 1, {}])(
    'defaults invalid external value %j to Automatic',
    (value) => {
      expect(normalizeClaudeCompactMetric(value)).toBe(DEFAULT_CLAUDE_COMPACT_METRIC)
    }
  )
})
