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
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))

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

  it.each([
    ['verbose', 'used'],
    ['verbose', 'remaining'],
    ['compact', 'used'],
    ['compact', 'remaining']
  ] as const)('ticks without new quota data in %s mode with %s percentages', (mode, display) => {
    const { container } = render(
      <ProviderSegment p={limits()} compact={false} mode={mode} display={display} />
    )
    expect(container.textContent).toContain('5h (1h 30m)')
    expect(container.textContent).toContain(display === 'used' ? '90%' : '10%')

    act(() => vi.advanceTimersByTime(30_001))
    expect(container.textContent).toContain('5h (1h 29m)')

    act(() => vi.advanceTimersByTime(MINUTE))
    expect(container.textContent).toContain('5h (1h 28m)')
  })

  it.each(['verbose', 'compact'] as const)(
    'identifies the limiting window when both pools reset together in %s mode',
    (mode) => {
      const p = limits()
      p.buckets?.push({
        name: 'Gemini Models · Weekly Limit Remaining',
        group: 'Gemini Models',
        windowName: 'Weekly Limit Remaining',
        usedPercent: 95,
        windowMinutes: 10_080,
        resetsAt: START + 90 * MINUTE + 30_000,
        resetDescription: null
      })
      const { container } = render(
        <ProviderSegment p={p} compact={false} mode={mode} display="remaining" />
      )

      if (mode === 'verbose') {
        expect(container.textContent).toContain('10% 5h (1h 30m)')
        expect(container.textContent).toContain('5% wk (1h 30m)')
      } else {
        expect(container.textContent).toBe('5% Gemini wk (1h 30m)')
      }
    }
  )

  it('shows now at the reset and stops scheduling updates', () => {
    vi.setSystemTime(START + 90 * MINUTE)
    const { container } = render(<ProviderSegment p={limits()} compact={false} display="used" />)
    expect(container.textContent).toContain('5h (0m)')
    act(() => vi.advanceTimersByTime(30_001))
    expect(container.textContent).toContain('5h (now)')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts the clock when an idle segment receives an urgent pool', () => {
    const { container, rerender } = render(
      <ProviderSegment p={null} compact={false} display="used" />
    )
    rerender(<ProviderSegment p={limits()} compact={false} display="used" />)
    act(() => vi.advanceTimersByTime(30_001))
    expect(container.textContent).toContain('1h 29m')
  })

  it('does not schedule countdown updates for nonurgent pools', () => {
    const { container } = render(<ProviderSegment p={limits(79)} compact={false} display="used" />)
    expect(container.textContent).toContain('5h')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule countdown updates when compact labels are hidden', () => {
    const { container } = render(
      <ProviderSegment p={limits()} compact mode="compact" display="used" />
    )
    expect(container.textContent).toBe('90%')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['idle', 'unavailable'] as const)(
    'does not schedule countdown updates for a hidden %s reading',
    (status) => {
      const { container } = render(
        <ProviderSegment p={{ ...limits(), status }} compact={false} display="used" />
      )
      expect(container.textContent).not.toContain('1h 30m')
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('stops countdown updates when the labels become hidden', () => {
    const { container, rerender } = render(
      <ProviderSegment p={limits()} compact={false} mode="compact" display="used" />
    )
    expect(container.textContent).toContain('1h 30m')
    expect(vi.getTimerCount()).toBe(1)

    rerender(<ProviderSegment p={limits()} compact mode="compact" display="used" />)
    expect(container.textContent).toBe('90%')
    expect(vi.getTimerCount()).toBe(0)
  })
})
