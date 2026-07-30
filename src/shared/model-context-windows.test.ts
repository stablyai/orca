import { describe, it, expect } from 'vitest'
import { getModelContextWindowTokens } from './model-context-windows'

describe('getModelContextWindowTokens', () => {
  it('returns 1M for Claude 1M-window families', () => {
    expect(getModelContextWindowTokens('claude-fable-5')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-opus-5')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-opus-4-8')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-opus-4-7')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-opus-4-6')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-sonnet-5')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-sonnet-4-6')).toBe(1_000_000)
  })

  it('returns the 200k floor for other Claude families', () => {
    expect(getModelContextWindowTokens('claude-sonnet-4-5')).toBe(200_000)
    expect(getModelContextWindowTokens('claude-sonnet-4')).toBe(200_000)
    expect(getModelContextWindowTokens('claude-opus-4-5')).toBe(200_000)
    expect(getModelContextWindowTokens('claude-opus-4-1')).toBe(200_000)
    expect(getModelContextWindowTokens('claude-haiku-4-5')).toBe(200_000)
    expect(getModelContextWindowTokens('claude-3-5-sonnet-20241022')).toBe(200_000)
  })

  it('treats the [1m] long-context marker as 1M regardless of family', () => {
    expect(getModelContextWindowTokens('claude-sonnet-4-5[1m]')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-sonnet-4[1m]')).toBe(1_000_000)
  })

  it('returns unknown for uncurated Claude ids', () => {
    expect(getModelContextWindowTokens('claude-next-99')).toBeUndefined()
    expect(getModelContextWindowTokens('claude-sonnet-50')).toBeUndefined()
    expect(getModelContextWindowTokens('my-claude-wrapper')).toBeUndefined()
  })

  it('matches case-insensitively with whitespace, dotted aliases, and provider prefixes', () => {
    expect(getModelContextWindowTokens('  Claude-Opus-4-6  ')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-opus-4.6-thinking')).toBe(1_000_000)
    expect(getModelContextWindowTokens('anthropic.claude-opus-5')).toBe(1_000_000)
    expect(getModelContextWindowTokens('us.anthropic.claude-sonnet-4-5-20250929-v2:0')).toBe(
      200_000
    )
  })

  it('matches suffixed variants of 1M families (dates, -thinking)', () => {
    expect(getModelContextWindowTokens('claude-sonnet-4-6-thinking')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-opus-4-8-20260101')).toBe(1_000_000)
  })

  it('returns 272k only for curated Codex model families', () => {
    expect(getModelContextWindowTokens('gpt-5.2-codex')).toBe(272_000)
    expect(getModelContextWindowTokens('gpt-5.3-codex-high')).toBe(272_000)
    expect(getModelContextWindowTokens('openai-codex/gpt-5.1-codex-max')).toBe(272_000)
    expect(getModelContextWindowTokens('gpt-5')).toBeUndefined()
    expect(getModelContextWindowTokens('gpt-5.4-mini')).toBeUndefined()
    expect(getModelContextWindowTokens('gpt-5.6-terra-high')).toBeUndefined()
  })

  it('does not stretch the GPT-5 floor to other GPT families', () => {
    expect(getModelContextWindowTokens('gpt-4o')).toBeUndefined()
    // Why: a digit right after the prefix is a different family, not a suffix.
    expect(getModelContextWindowTokens('gpt-50')).toBeUndefined()
    expect(getModelContextWindowTokens('gpt-5o-mini')).toBeUndefined()
  })

  it('returns undefined for unknown and empty ids (honest fallback)', () => {
    expect(getModelContextWindowTokens('gemini-2.5-pro')).toBeUndefined()
    expect(getModelContextWindowTokens('')).toBeUndefined()
    expect(getModelContextWindowTokens('   ')).toBeUndefined()
  })
})
