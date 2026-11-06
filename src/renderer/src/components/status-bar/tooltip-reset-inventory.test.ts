import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) =>
      values?.[key] === undefined ? placeholder : String(values[key])
    )
}))

import { ProviderPanel } from './tooltip'

function inventoryMarkup(provider: 'codex' | 'zcode', availableCount: number | null): string {
  const p: ProviderRateLimits = {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    rateLimitResetCredits:
      availableCount === null ? null : { availableCount, nextExpiresAt: 1_792_800_000_000 }
  }
  return renderToStaticMarkup(createElement(ProviderPanel, { p }))
}

describe('ProviderPanel reset inventory', () => {
  it.each([
    ['codex', '0 rate-limit resets available'],
    ['zcode', '0 five-hour rate-limit resets available']
  ] as const)(
    'distinguishes exhausted %s inventory from unavailable inventory',
    (provider, label) => {
      const exhausted = inventoryMarkup(provider, 0)
      expect(exhausted).toContain(label)
      expect(exhausted).not.toContain('expires')
      expect(exhausted).not.toContain('Expires')
      expect(inventoryMarkup(provider, null)).not.toContain('resets available')
    }
  )
})
