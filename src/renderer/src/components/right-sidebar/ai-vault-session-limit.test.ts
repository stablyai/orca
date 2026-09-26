import { describe, expect, it } from 'vitest'
import { aiVaultSessionsFillLimit, aiVaultViewMayHoldMoreSessions } from './ai-vault-session-limit'

describe('aiVaultSessionsFillLimit', () => {
  it('is true only once the scan returned as many rows as it was allowed', () => {
    expect(aiVaultSessionsFillLimit(500, 500)).toBe(true)
    expect(aiVaultSessionsFillLimit(499, 500)).toBe(false)
    expect(aiVaultSessionsFillLimit(5000, 'unlimited')).toBe(false)
    expect(aiVaultSessionsFillLimit(0, null)).toBe(false)
  })
})

describe('aiVaultViewMayHoldMoreSessions', () => {
  const capped = { loaded: 500, loadedSessionLimit: 500 } as const

  it('says no when the scan had room left, whatever the tab', () => {
    for (const scope of ['all', 'workspace', 'project'] as const) {
      expect(
        aiVaultViewMayHoldMoreSessions({
          scope,
          loaded: 12,
          loadedSessionLimit: 500,
          scopeFullyScanned: false
        })
      ).toBe(false)
    }
  })

  it('says yes on All whenever the scan stopped at its depth', () => {
    expect(
      aiVaultViewMayHoldMoreSessions({ ...capped, scope: 'all', scopeFullyScanned: true })
    ).toBe(true)
  })

  // Why: only Claude and Pi bucket transcripts by cwd. For Codex, Cursor, Gemini
  // and the rest a scoped tab is a filter over the capped list, so a deeper scan
  // genuinely adds in-scope rows — the scanner is the only thing that knows which.
  it('trusts the scanner, not the tab, for a scoped view', () => {
    expect(
      aiVaultViewMayHoldMoreSessions({ ...capped, scope: 'workspace', scopeFullyScanned: false })
    ).toBe(true)
    expect(
      aiVaultViewMayHoldMoreSessions({ ...capped, scope: 'workspace', scopeFullyScanned: true })
    ).toBe(false)
    expect(
      aiVaultViewMayHoldMoreSessions({ ...capped, scope: 'project', scopeFullyScanned: true })
    ).toBe(false)
  })
})
