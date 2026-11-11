// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ProviderSegment } from './StatusBarProviderSegment'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
vi.mock('@/components/agent/icons/AgentIcon', () => ({
  AgentIcon: () => null
}))

const START = Date.UTC(2026, 9, 8, 12)
const MINUTE = 60_000

function limits(usedPercent = 90): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    buckets: [
      {
        name: 'Gemini Models · 5h Limit Remaining',
        group: 'Gemini Models',
        windowName: '5h Limit Remaining',
        usedPercent,
        windowMinutes: 300,
        resetsAt: START + 90 * MINUTE + 30_000,
        resetDescription: null
      }
    ],
    status: 'ok',
    error: null,
    updatedAt: START
  }
}

describe('status-bar pool countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('starts the clock when an idle segment receives an urgent pool', () => {
    const { container, rerender } = render(
      <ProviderSegment p={null} compact={false} display="used" />
    )
    rerender(<ProviderSegment p={limits()} compact={false} display="used" />)
    act(() => vi.advanceTimersByTime(30_001))
    expect(container.textContent).toContain('1h 29m')
  })
})
