import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ProviderSegment } from './StatusBarProviderSegment'
import { ProviderPanel } from './tooltip'

const reading: ProviderRateLimits = {
  provider: 'kiro',
  session: null,
  weekly: null,
  monthly: {
    usedPercent: 17.9512,
    windowMinutes: 43200,
    resetsAt: Date.now() + 14 * 86400000,
    resetDescription: null
  },
  usageAmount: { used: 1795.12, limit: 10000, unit: 'credits' },
  planType: 'KIRO POWER',
  updatedAt: Date.now(),
  error: null,
  status: 'ok'
}

export const monthly = defineFixture({
  width: 560,
  render: () => (
    <div className="space-y-4 bg-background p-4 text-foreground">
      <div className="flex items-center gap-4">
        <ProviderSegment
          p={{ ...reading, provider: 'claude', usageAmount: undefined }}
          compact={false}
          display="used"
        />
        <ProviderSegment p={reading} compact={false} display="used" />
      </div>
      <ProviderPanel p={reading} />
    </div>
  )
})

export const before = defineFixture({
  width: 560,
  render: () => (
    <div className="space-y-4 bg-background p-4 text-foreground">
      <div className="flex items-center gap-4">
        <ProviderSegment
          p={{ ...reading, provider: 'claude', usageAmount: undefined }}
          compact={false}
          display="used"
        />
      </div>
    </div>
  )
})
