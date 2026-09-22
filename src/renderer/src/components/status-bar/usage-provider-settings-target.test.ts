import { describe, expect, it } from 'vitest'
import { getUsageProviderAccountsSectionId } from './usage-provider-settings-target'

describe('getUsageProviderAccountsSectionId', () => {
  it('routes providers only to settings sections that exist', () => {
    expect(getUsageProviderAccountsSectionId('claude')).toBe('accounts-claude')
    expect(getUsageProviderAccountsSectionId('codex')).toBe('accounts-codex')
    expect(getUsageProviderAccountsSectionId('gemini')).toBe('accounts-gemini')
    expect(getUsageProviderAccountsSectionId('opencode-go')).toBe('accounts-opencode-go')
    expect(getUsageProviderAccountsSectionId('minimax')).toBe('accounts-minimax')
    expect(getUsageProviderAccountsSectionId('grok')).toBe('accounts-grok')
  })

  it('does not invent an Accounts section for CLI-owned Kimi credentials', () => {
    expect(getUsageProviderAccountsSectionId('kimi')).toBeNull()
  })

  it("does not route Antigravity into another provider's Accounts section", () => {
    // Why: `accounts-gemini` configures Gemini, not Antigravity — a sign-in CTA there
    // sends the user to the wrong provider (#14515).
    expect(getUsageProviderAccountsSectionId('antigravity')).toBeNull()
  })
})
