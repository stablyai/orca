import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { formatBareUsagePercentage } from './usage-percentage-label'

describe('formatBareUsagePercentage localization', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('fr')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('uses the French spacing before the percent sign', () => {
    expect(formatBareUsagePercentage(4, 'used')).toBe('4 %')
  })
})
