import { describe, expect, it } from 'vitest'
import type { ClaudeUsageDailyPoint } from '../../../../shared/claude-usage-types'
import type { CodexUsageDailyPoint } from '../../../../shared/codex-usage-types'
import { ClaudeUsageDailyChart } from './ClaudeUsageDailyChart'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'

function makeDay(index: number): string {
  return new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)
}

describe('usage daily charts', () => {
  it('renders Codex/OpenCode daily charts for very large histories', () => {
    const daily: CodexUsageDailyPoint[] = Array.from({ length: 130_000 }, (_, index) => ({
      day: makeDay(index),
      inputTokens: index + 1,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: index + 1
    }))

    expect(() => CodexUsageDailyChart({ daily })).not.toThrow()
  })

  it('renders Claude daily charts for very large histories', () => {
    const daily: ClaudeUsageDailyPoint[] = Array.from({ length: 130_000 }, (_, index) => ({
      day: makeDay(index),
      inputTokens: index + 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }))

    expect(() => ClaudeUsageDailyChart({ daily })).not.toThrow()
  })
})
