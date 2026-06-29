import { describe, expect, it } from 'vitest'
import { hasCodexNativeDraftFlag } from './codex-startup-delivery'
import { maybeWrapCodexStartupRetry } from './codex-startup-retry'

describe('hasCodexNativeDraftFlag', () => {
  it('matches Codex --prefill option tokens', () => {
    expect(hasCodexNativeDraftFlag("codex --prefill 'linked issue context'")).toBe(true)
    expect(hasCodexNativeDraftFlag("codex --model gpt-5 --prefill 'draft'")).toBe(true)
  })

  it('matches Codex --prefill=value option tokens', () => {
    expect(hasCodexNativeDraftFlag('codex --prefill=review')).toBe(true)
    expect(hasCodexNativeDraftFlag("codex --prefill='linked issue context'")).toBe(true)
  })

  it('does not match quoted prompt text mentioning prefill', () => {
    expect(hasCodexNativeDraftFlag("codex 'please compare --prefill behavior'")).toBe(false)
    expect(hasCodexNativeDraftFlag("codex '--prefill=not-an-option'")).toBe(false)
  })

  it('matches native draft flags inside Orca Codex retry wrappers', () => {
    expect(
      hasCodexNativeDraftFlag(
        maybeWrapCodexStartupRetry('codex', "codex --prefill 'linked issue context'", 'posix')
      )
    ).toBe(true)
    expect(
      hasCodexNativeDraftFlag(
        maybeWrapCodexStartupRetry('codex', "codex 'please compare --prefill behavior'", 'posix')
      )
    ).toBe(false)
  })

  it('does not match non-Codex commands', () => {
    expect(hasCodexNativeDraftFlag("claude --prefill 'review this'")).toBe(false)
  })

  it('leaves plain Codex and normal Codex arguments on the fast path', () => {
    expect(hasCodexNativeDraftFlag('codex')).toBe(false)
    expect(hasCodexNativeDraftFlag('codex --model gpt-5')).toBe(false)
  })
})
