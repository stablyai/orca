// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../../shared/rate-limit-types'

vi.mock('@/components/agent/icons/AgentIcon', () => ({ AgentIcon: () => null }))

const { UsageRow } = await import('./UsageRosterPanel')

afterEach(cleanup)

function win(usedPercent: number, windowMinutes: number): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function claude(windows: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...windows
  }
}

function renderRow(p: ProviderRateLimits, mode: 'verbose' | 'compact') {
  return render(
    <UsageRow
      p={p}
      display="used"
      state={{ kind: 'usage', statusLabel: null }}
      showSignInAction={false}
      now={0}
      mode={mode}
    />
  ).container
}

const healthy = claude({
  session: win(12, 300),
  weekly: win(33, 10_080),
  fableWeekly: win(5, 10_080)
})

it('lists every window under the row in Detailed mode only', () => {
  expect(renderRow(healthy, 'verbose').querySelectorAll('[data-usage-window]')).toHaveLength(3)
  expect(renderRow(healthy, 'compact').querySelectorAll('[data-usage-window]')).toHaveLength(0)
})

function withReset(window: RateLimitWindow): RateLimitWindow {
  return { ...window, resetsAt: 3 * 3_600_000 }
}

it('reads as not checked when only a Fable reading below 90% exists', () => {
  const row = renderRow(claude({ fableWeekly: win(50, 10_080) }), 'compact')
  expect(row.querySelector('[data-usage-not-checked]')).not.toBeNull()
  expect(row.querySelector('[data-usage-bar]')).toBeNull()
})

it('names a nearly spent Fable limit beside not checked when no ordinary reading exists', () => {
  const row = renderRow(claude({ fableWeekly: win(100, 10_080) }), 'compact')
  expect(row.querySelector('[data-usage-scoped-urgent]')?.textContent).toBe('Fable 100%')
  expect(row.querySelector('[data-usage-not-checked]')).not.toBeNull()
})

it('flags a spent Fable limit in place of the reset while the headline is healthy', () => {
  const row = renderRow(
    claude({ weekly: withReset(win(33, 10_080)), fableWeekly: win(100, 10_080) }),
    'compact'
  )
  expect(row.querySelector('[data-usage-scoped-urgent]')?.textContent).toBe('Fable 100%')
  expect(row.querySelector('[data-usage-reset]')).toBeNull()
})

it('keeps the headline reset when the headline itself is nearly spent', () => {
  const row = renderRow(
    claude({ weekly: withReset(win(100, 10_080)), fableWeekly: win(100, 10_080) }),
    'compact'
  )
  expect(row.querySelector('[data-usage-reset]')?.textContent).toBe('3h')
  expect(row.querySelector('[data-usage-scoped-urgent]')).toBeNull()
})
