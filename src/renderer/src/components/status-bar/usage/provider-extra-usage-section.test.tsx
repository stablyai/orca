// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ExtraUsageBalance } from '../../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../../shared/usage-percentage-display'
import { ProviderExtraUsageSection } from './provider-extra-usage-section'

afterEach(cleanup)

const quarterSpent: ExtraUsageBalance = {
  unit: 'currency',
  enabled: true,
  disabledReason: null,
  resetsAt: null,
  balance: 75,
  currencyCode: 'USD',
  spent: 25,
  spendLimit: 100,
  spentPercent: 25
}

function fillWidth(display: UsagePercentageDisplay): string | undefined {
  const { container } = render(
    <ProviderExtraUsageSection
      balance={quarterSpent}
      provider="claude"
      textClass=""
      mutedClass=""
      faintClass=""
      emptyBarClass=""
      usagePercentageDisplay={display}
    />
  )
  const fill = container.querySelector<HTMLElement>('[style*="width"]')
  const width = fill?.style.width
  cleanup()
  return width
}

it('fills the spend bar with the percentage the user chose to see', () => {
  expect(fillWidth('used')).toBe('25%')
  expect(fillWidth('remaining')).toBe('75%')
})
