import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

import { ProviderPanel } from './tooltip'

describe('ProviderPanel unlimited usage', () => {
  it('renders stale unlimited usage alongside its refresh error', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderPanel, {
        p: {
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: 0,
          error: 'temporary failure',
          status: 'error',
          planType: 'business',
          isUnlimited: true
        }
      })
    )

    expect(markup).toContain('Unlimited usage')
    expect(markup).toContain('temporary failure')
    expect(markup).toContain('Refresh failed — showing cached data')
  })
})
