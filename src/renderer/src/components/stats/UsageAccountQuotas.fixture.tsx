import { defineFixture } from '../../component-fixtures/component-fixture'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { UsageAccountQuotas } from './UsageAccountQuotas'

const checkedAt = Date.UTC(2026, 9, 28, 6)
function quota(provider: ProviderRateLimits['provider'], usedPercent: number): ProviderRateLimits {
  return {
    provider,
    planType: 'plus',
    status: 'ok',
    error: null,
    updatedAt: checkedAt,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: checkedAt + 3600000,
      resetDescription: null
    },
    weekly: {
      usedPercent: usedPercent + 10,
      windowMinutes: 10080,
      resetsAt: checkedAt + 86400000,
      resetDescription: null
    }
  }
}

export const reportedWindows = defineFixture({
  width: 800,
  render: () => (
    <div className="@container bg-background p-5">
      <UsageAccountQuotas
        rateLimits={createEmptyRateLimitState({
          codex: quota('codex', 27),
          claude: quota('claude', 42)
        })}
        ownerLabel="Build server"
        onRefresh={() => {}}
        onManage={() => {}}
      />
    </div>
  )
})

export const savedProviderAccounts = defineFixture({
  width: 800,
  render: () => (
    <div className="@container bg-background p-5">
      <UsageAccountQuotas
        accounts={{
          claude: { accounts: [], activeAccountId: null },
          codex: { accounts: [], activeAccountId: null },
          rateLimits: null
        }}
        rateLimits={createEmptyRateLimitState({
          muse: quota('muse', 24),
          antigravity: quota('antigravity', 31),
          antigravityAccounts: [
            {
              accountId: 'work',
              email: 'work@example.test',
              active: true,
              rateLimits: quota('antigravity', 31)
            },
            {
              accountId: 'personal',
              email: 'personal@example.test',
              active: false,
              rateLimits: quota('antigravity', 64)
            },
            { accountId: 'unread', email: 'unread@example.test', active: false, rateLimits: null }
          ]
        })}
        ownerLabel="Build server"
        onRefresh={() => {}}
        onManage={() => {}}
      />
    </div>
  )
})
