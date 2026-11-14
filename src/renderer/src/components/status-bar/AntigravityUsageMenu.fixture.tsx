import { defineFixture } from '../../component-fixtures/component-fixture'
import type {
  AntigravityAccountUsage,
  ProviderRateLimits
} from '../../../../shared/rate-limit-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AntigravityUsageMenu } from './AntigravityUsageMenu'

const NOW = Date.now()
const HOUR = 60 * 60 * 1000

function reading(weekly: number, session: number, readAt: number): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: {
      usedPercent: session,
      windowMinutes: 300,
      resetsAt: NOW + 2 * HOUR,
      resetDescription: null
    },
    weekly: {
      usedPercent: weekly,
      windowMinutes: 10080,
      resetsAt: NOW + 72 * HOUR,
      resetDescription: null
    },
    updatedAt: readAt,
    error: null,
    status: 'ok'
  }
}

const live: ProviderRateLimits = {
  ...reading(42, 18, NOW - 60_000),
  usageMetadata: { account: { id: 'a', email: 'work@example.com' } }
}

const accounts: AntigravityAccountUsage[] = [
  { accountId: 'a', email: 'work@example.com', active: true, rateLimits: live },
  {
    accountId: 'b',
    email: 'personal@example.com',
    active: false,
    rateLimits: reading(87, 64, NOW - 5 * HOUR)
  },
  { accountId: 'c', email: 'side-project@example.com', active: false, rateLimits: null }
]

export const savedAccounts = defineFixture({
  width: 520,
  render: () => (
    <div className="flex h-[520px] items-end bg-background p-3">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AntigravityUsageMenu
            antigravity={live}
            accounts={accounts}
            compact={false}
            triggerContent="Antigravity"
            onManageAccounts={() => {}}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
  interact: (frame) => {
    const trigger = frame.ownerDocument.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-sub-trigger"]'
    )
    trigger?.focus()
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  }
})
