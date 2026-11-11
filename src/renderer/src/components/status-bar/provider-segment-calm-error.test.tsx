import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('@/components/agent/icons/AgentIcon', () => ({
  AgentIcon: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

// NS-03 (Neil): "Refresh failed" and "⚠ Sign-in expired" sat in the status bar for good. A failed
// usage read now shows a quiet "--" with the reason as its label; the usage card explains it.
describe('ProviderSegment calm error', () => {
  it.each([
    ['cursor', 'stale-token', 'Sign-in expired'],
    ['gemini', 'unknown', 'Refresh failed'],
    // design-squad P3: "⚠ Usage unavailable" twice (Claude + Codex) in a cloud workspace.
    ['claude', 'usage-unavailable', 'Usage unavailable']
  ] as const)(
    '%s %s renders "--", no warning icon, label kept for a11y',
    async (provider, kind, label) => {
      const { ProviderSegment } = await import('./StatusBar')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal error-state fixture.
      const p = {
        provider,
        session: null,
        weekly: null,
        updatedAt: 0,
        error: 'boom',
        status: 'error',
        usageMetadata: { failureKind: kind }
      } as unknown as ProviderRateLimits
      const html = renderToStaticMarkup(
        <ProviderSegment p={p} compact={false} display="used" mode="verbose" />
      )
      expect(html).toContain('--')
      expect(html).toContain(`aria-label="${label}"`)
      expect(html).not.toContain(`>${label}<`)
      expect(html).not.toContain('lucide-triangle-alert')
    }
  )

  it('owner not set up (e.g. "Not configured on Orca Cloud") is the same quiet "--"', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal placeholder fixture.
    const p = {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: 0,
      error: 'Not configured on Orca Cloud',
      status: 'error',
      usageMetadata: {
        ownerNotSetUp: {
          kind: 'not-configured',
          ownerLabel: 'Orca Cloud',
          signInSavedHereOnly: false
        }
      }
    } as unknown as ProviderRateLimits
    const html = renderToStaticMarkup(
      <ProviderSegment p={p} compact={false} display="used" mode="verbose" />
    )
    expect(html).toContain('--')
    expect(html).toContain('Not configured on Orca Cloud')
    expect(html).not.toContain('>Not configured on')
  })
})
