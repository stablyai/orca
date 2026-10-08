import { describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

vi.mock('@/lib/agent-catalog', async () => {
  const ReactActual = await vi.importActual<typeof ReactModule>('react')
  return {
    AgentIcon: ({ agent }: { agent: string }) =>
      ReactActual.createElement('span', { 'data-agent-icon': agent })
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

import { formatRateLimitResetLabel } from './tooltip'

describe('formatRateLimitResetLabel', () => {
  it('shows a date-only reset without inventing an exact countdown', () => {
    expect(
      formatRateLimitResetLabel({
        usedPercent: 62,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: '2026-09-01'
      })
    ).toBe('Resets on 2026-09-01')
  })

  it('keeps non-date reset descriptions instead of dropping the label', () => {
    expect(
      formatRateLimitResetLabel({
        usedPercent: 62,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: 'Thu'
      })
    ).toBe('Thu')
    expect(
      formatRateLimitResetLabel({
        usedPercent: 62,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: '2:30 PM'
      })
    ).toBe('2:30 PM')
  })

  it('omits the reset label when the window has no reset metadata', () => {
    expect(
      formatRateLimitResetLabel({
        usedPercent: 62,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: null
      })
    ).toBeNull()
  })
})
