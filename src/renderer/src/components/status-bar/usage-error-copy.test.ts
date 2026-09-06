import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { getProviderDisplayName, getProviderUsageErrorMessage } from './usage-error-copy'

describe('getProviderDisplayName', () => {
  it('returns the Antigravity brand name', () => {
    expect(getProviderDisplayName('antigravity')).toBe('Antigravity')
  })

  it('returns the MiniMax brand name', () => {
    expect(getProviderDisplayName('minimax')).toBe('MiniMax')
  })

  it('returns the existing provider brand names', () => {
    expect(getProviderDisplayName('claude')).toBe('Claude')
    expect(getProviderDisplayName('codex')).toBe('Codex')
    expect(getProviderDisplayName('gemini')).toBe('Gemini')
    expect(getProviderDisplayName('opencode-go')).toBe('OpenCode Go')
    expect(getProviderDisplayName('kimi')).toBe('Kimi')
    expect(getProviderDisplayName('grok')).toBe('Grok')
  })

  it('falls back to the raw provider id when no mapping exists', () => {
    // Why: provider id is a closed union, but TypeScript may not enforce
    // exhaustiveness on dynamic callers. Fallback keeps logging safe.
    expect(getProviderDisplayName('unknown-provider' as never)).toBe('unknown-provider')
  })
})

describe('getProviderUsageErrorMessage', () => {
  // Why: a body Orca could not read is classified 'parse'. That is the field the copy switch
  // reads, and it is what keeps the internal diagnostic out of the user-facing tooltip.
  it('replaces an unreadable Claude usage body with user-facing copy', () => {
    expect(
      getProviderUsageErrorMessage({
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: 0,
        error: 'Claude usage response contained no usage window',
        status: 'error',
        usageMetadata: { failureKind: 'parse' }
      })
    ).toBe('Claude usage is unavailable right now.')
  })

  it('surfaces the raw reason when the failure was never classified', () => {
    expect(
      getProviderUsageErrorMessage({
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: 0,
        error: 'Claude usage response contained no usage window',
        status: 'error'
      })
    ).toBe('Claude usage response contained no usage window')
  })
})
