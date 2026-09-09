import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/lib/agent-catalog', async () => {
  const ReactActual = await vi.importActual<typeof ReactModule>('react')
  return {
    AgentIcon: ({ agent }: { agent: string }) =>
      ReactActual.createElement('span', { 'data-agent-icon': agent })
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    values
      ? Object.entries(values).reduce(
          (text, [token, value]) => text.replace(`{{${token}}}`, String(value)),
          fallback
        )
      : fallback
}))

import { ProviderPanel } from './tooltip'

afterEach(() => {
  vi.useRealTimers()
})

describe('ProviderPanel Grok reset tokens', () => {
  it('shows SuperGrok remaining reset tokens', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T12:00:00Z'))
    const provider: ProviderRateLimits = {
      provider: 'grok',
      status: 'ok',
      session: null,
      weekly: {
        usedPercent: 13,
        windowMinutes: 10_080,
        resetsAt: Date.parse('2026-09-03T12:58:43Z'),
        resetDescription: 'Thu'
      },
      rateLimitResetCredits: {
        availableCount: 1,
        nextExpiresAt: Date.parse('2026-09-12T18:49:00Z')
      },
      updatedAt: Date.now(),
      error: null
    }

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: provider }))

    expect(markup).toContain('1 rate-limit reset available')
    expect(markup).toContain('Expires in')
  })
})
