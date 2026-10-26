import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const messages = vi.hoisted(() => ({ notConfigured: '' }))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (key: string, fallback: string, values?: Record<string, string>) => {
    let result =
      key.endsWith('remoteOwnerNotConfigured') && messages.notConfigured
        ? messages.notConfigured
        : fallback
    for (const [name, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${name}}}`, value)
    }
    return result
  }
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

const { ProviderSegment } = await import('./StatusBarProviderSegment')

function placeholder(ownerLabel: string): ProviderRateLimits {
  return {
    provider: 'minimax',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: `Not configured on ${ownerLabel}\nIts sign-in is saved on this computer only.`,
    status: 'error',
    usageMetadata: {
      ownerNotSetUp: { kind: 'not-configured', ownerLabel, signInSavedHereOnly: true }
    }
  }
}

function claudeUnknownPlaceholder(ownerLabel: string): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: `Claude usage isn't available from ${ownerLabel}. It may not be signed in there, or it may use API-key billing.`,
    status: 'error',
    usageMetadata: { ownerNotSetUp: { kind: 'claude-unknown', ownerLabel } }
  }
}

describe('ProviderSegment owner placeholder', () => {
  it('names the host in the chip, truncating only the name, with no warning glyph', () => {
    const markup = renderToStaticMarkup(
      <ProviderSegment p={placeholder('devbox')} compact={false} display="used" />
    )
    expect(markup).toContain(
      'Not configured on <span data-owner-host="true" class="inline-block max-w-28 truncate align-bottom">devbox</span>'
    )
    expect(markup).toContain(
      'title="Not configured on devbox\nIts sign-in is saved on this computer only."'
    )
    // Why: a placeholder is not a failure, so no warning glyph or refresh-failed copy.
    expect(markup).not.toContain('lucide-triangle-alert')
    expect(markup).not.toContain('Refresh failed')
  })

  it('keeps the phrase around a mid-sentence host name and renders a "<" in it as text', () => {
    messages.notConfigured = '{{server}} では未構成'
    try {
      const markup = renderToStaticMarkup(
        <ProviderSegment p={placeholder('<prod>')} compact={false} display="used" />
      )
      expect(markup).toContain('truncate align-bottom">&lt;prod&gt;</span> では未構成')
    } finally {
      messages.notConfigured = ''
    }
  })

  it('shows "--" instead of the label in compact density, keeping the tooltip', () => {
    const markup = renderToStaticMarkup(
      <ProviderSegment p={placeholder('devbox')} compact display="used" />
    )
    expect(markup).not.toContain('data-owner-host')
    // Why: an icon alone would read as a healthy chip.
    expect(markup).toContain('--')
    expect(markup).toContain('title="Not configured on devbox')
  })

  it('says Claude shows no usage from the host, never that it is not configured there', () => {
    const markup = renderToStaticMarkup(
      <ProviderSegment p={claudeUnknownPlaceholder('devbox')} compact={false} display="used" />
    )
    expect(markup).toContain(
      'No usage from <span data-owner-host="true" class="inline-block max-w-28 truncate align-bottom">devbox</span>'
    )
    expect(markup).toContain(
      'title="Claude usage isn&#x27;t available from devbox. It may not be signed in there, or it may use API-key billing."'
    )
    expect(markup).not.toContain('Not configured')
    expect(markup).not.toContain('lucide-triangle-alert')
  })
})
