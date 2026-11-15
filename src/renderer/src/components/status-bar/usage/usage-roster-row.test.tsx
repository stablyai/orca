// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { UsageRow } from './UsageRosterPanel'

afterEach(cleanup)

function fableOnly(status: ProviderRateLimits['status'], usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    fableWeekly: { usedPercent, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    updatedAt: 0,
    error: status === 'error' ? 'Network error' : null,
    status
  }
}

function renderRow(
  p: ProviderRateLimits,
  display: UsagePercentageDisplay = 'used',
  mode: 'compact' | 'verbose' = 'compact'
) {
  return render(
    <UsageRow
      p={p}
      display={display}
      state={{ kind: 'usage', statusLabel: null }}
      showSignInAction={false}
      now={0}
      mode={mode}
    />
  ).container
}

describe('UsageRow with only a Fable reading', () => {
  // Why error and fetching: a failed or in-flight refresh keeps the stored reading on screen.
  it.each(['ok', 'error', 'fetching'] as const)(
    'shows the Fable value when status is %s',
    (status) => {
      const row = renderRow(fableOnly(status, 100))
      expect(row.querySelector('[data-usage-scoped-only]')).not.toBeNull()
      expect(row.querySelector('[data-usage-not-checked]')).toBeNull()
    }
  )

  it('shows it below any warning level too', () => {
    const row = renderRow(fableOnly('ok', 40))
    expect(row.querySelector('[data-usage-scoped-only]')?.textContent).toContain('40')
  })

  it('titles the value with the shown percentage in Used and Left modes', () => {
    expect(
      renderRow(fableOnly('ok', 40), 'used')
        .querySelector('[data-usage-scoped-only]')
        ?.getAttribute('title')
    ).toContain('40')
    cleanup()
    expect(
      renderRow(fableOnly('ok', 40), 'remaining')
        .querySelector('[data-usage-scoped-only]')
        ?.getAttribute('title')
    ).toContain('60')
  })
})

it('titles the Fable figure on the Detailed line beside an ordinary reading', () => {
  const p: ProviderRateLimits = {
    ...fableOnly('ok', 40),
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null }
  }
  const titled = [...renderRow(p, 'used', 'verbose').querySelectorAll('[data-usage-window][title]')]
  expect(titled).toHaveLength(1)
  expect(titled[0]?.getAttribute('title')).toContain('40')
})
