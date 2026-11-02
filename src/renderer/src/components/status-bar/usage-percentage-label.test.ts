import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

import { formatBareUsagePercentage, formatUsagePercentageLabel } from './usage-percentage-label'

describe('formatUsagePercentageLabel', () => {
  it('formats used and remaining percentages without changing source semantics', () => {
    expect(formatUsagePercentageLabel(8, 'used')).toBe('8% used')
    expect(formatUsagePercentageLabel(8, 'remaining')).toBe('92% left')
  })
})

describe('formatBareUsagePercentage', () => {
  it('drops the used/left word but keeps the chosen display value', () => {
    expect(formatBareUsagePercentage(8, 'used')).toBe('8%')
    expect(formatBareUsagePercentage(8, 'remaining')).toBe('92%')
  })
})
