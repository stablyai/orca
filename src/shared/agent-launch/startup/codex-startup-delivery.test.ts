import { describe, expect, it } from 'vitest'
import { hasCodexNativeDraftFlag } from './codex-startup-delivery'

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
})
