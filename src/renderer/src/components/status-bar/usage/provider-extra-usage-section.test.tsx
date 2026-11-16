// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ExtraUsageBalance } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { ProviderExtraUsageSection } from './provider-extra-usage-section'

afterEach(cleanup)

function spendBarTone(spent: number): string | undefined {
  const balance: ExtraUsageBalance = {
    unit: 'currency',
    enabled: true,
    disabledReason: null,
    resetsAt: null,
    balance: 100 - spent,
    currencyCode: 'USD',
    spent,
    spendLimit: 100,
    spentPercent: spent
  }
  const { container } = render(
    <ProviderExtraUsageSection
      balance={balance}
      provider="claude"
      textClass=""
      mutedClass=""
      faintClass=""
      emptyBarClass=""
      usagePercentageDisplay="used"
    />
  )
  const tone = container.querySelector<HTMLElement>('[data-usage-bar]')?.dataset.usageTone
  cleanup()
  return tone
}

it('keeps the spend bar neutral until spending nears the cap', () => {
  expect(spendBarTone(25)).toBe('plain')
  expect(spendBarTone(85)).toBe('warning')
  expect(spendBarTone(95)).toBe('urgent')
})
