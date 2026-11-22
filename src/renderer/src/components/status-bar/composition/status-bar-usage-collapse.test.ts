import { expect, it } from 'vitest'
import { chooseUsageRowLayout, type UsageChipFacts } from './status-bar-usage-collapse'

// Six providers on a 600px window: the usage area keeps 330px beside the right-hand segments.
const WIDTHS = {
  available: 330,
  chipGap: 12,
  unitLabelWidth: 30,
  moreChipWidth: 26,
  chips: {
    claude: [110, 48, 48],
    codex: [110, 48, 48],
    antigravity: [130, 90, 48],
    kimi: [95, 45, 45],
    grok: [100, 45, 45],
    cursor: [100, 45, 45]
  }
} as const

it('keeps a nearly used-up provider in the row and folds a calm one instead', () => {
  const facts: UsageChipFacts[] = Object.keys(WIDTHS.chips).map((provider) => ({
    provider,
    urgent: provider === 'grok',
    percentage: [true, true, true]
  }))
  expect(chooseUsageRowLayout(WIDTHS, facts)).toEqual({
    level: 2,
    collapsed: ['cursor', 'kimi']
  })
})
