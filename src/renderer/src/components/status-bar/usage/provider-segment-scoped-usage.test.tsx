// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/rate-limit-types'

vi.mock('@/components/agent/icons/AgentIcon', () => ({ AgentIcon: () => null }))

const { ProviderSegment } = await import('./StatusBarProviderSegment')

afterEach(cleanup)

function fableOnly(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    fableWeekly: { usedPercent, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    updatedAt: 0,
    error: null,
    status: 'ok'
  }
}

it.each(['verbose', 'compact'] as const)(
  'names a nearly spent Fable limit when only Fable was read (%s)',
  (mode) => {
    for (const compact of [false, true]) {
      const { container } = render(
        <ProviderSegment p={fableOnly(100)} compact={compact} display="used" mode={mode} />
      )
      expect(container.querySelector('[data-usage-scoped-urgent]')).not.toBeNull()
      cleanup()
    }
  }
)

it('stays quiet about a Fable-only reading below 90%', () => {
  const { container } = render(
    <ProviderSegment p={fableOnly(50)} compact={false} display="used" mode="verbose" />
  )
  expect(container.querySelector('[data-usage-scoped-urgent]')).toBeNull()
  expect(container.querySelector('[data-usage-not-checked]')).not.toBeNull()
})
