import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { GrokUsageMenu } from './GrokUsageMenu'

const NOW = Date.now()

const grok: ProviderRateLimits = {
  provider: 'grok',
  session: null,
  weekly: {
    usedPercent: 92,
    windowMinutes: 10080,
    resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
    resetDescription: null
  },
  updatedAt: NOW - 60_000,
  error: null,
  status: 'ok'
}

export const nearLimit = defineFixture({
  width: 520,
  render: () => (
    <div className="flex h-[360px] items-end bg-background p-3">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
        <DropdownMenuContent>
          <GrokUsageMenu grok={grok} compact={false} triggerContent="Grok" />
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
