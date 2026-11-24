import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { UsageRosterPanel } from './UsageRosterPanel'

const NOW = Date.now()
const HOUR = 60 * 60 * 1000

const claude: ProviderRateLimits = {
  provider: 'claude',
  session: { usedPercent: 6, windowMinutes: 300, resetsAt: NOW + 4 * HOUR, resetDescription: null },
  weekly: {
    usedPercent: 4,
    windowMinutes: 10080,
    resetsAt: NOW + 89 * HOUR,
    resetDescription: null
  },
  updatedAt: NOW - 60_000,
  error: null,
  status: 'ok'
}

const expiredCursor: ProviderRateLimits = {
  provider: 'cursor',
  session: null,
  weekly: null,
  buckets: [],
  updatedAt: NOW - 60_000,
  error: 'Cursor sign-in expired — run `cursor-agent login` again',
  status: 'error',
  usageMetadata: { failureKind: 'stale-token' }
}

const noop = (): void => {}

export const expiredCursorFlyout = defineFixture({
  width: 940,
  render: () => (
    <div className="flex h-[420px] items-end bg-background p-3">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
        <DropdownMenuContent align="start" variant="picker" className="w-[440px]">
          <UsageRosterPanel
            providers={[claude, expiredCursor]}
            display="used"
            statusBarUsageMode="verbose"
            onStatusBarUsageModeChange={noop}
            isRefreshing={false}
            onRefresh={noop}
            onOpenProvider={noop}
            onSignIn={noop}
            canSignIn={() => false}
            onManageAccounts={noop}
            onUsageDetails={noop}
            renderRow={(p, row) => (
              <ProviderDetailsMenu
                provider={p}
                asSubmenu
                triggerContent={row}
                ariaLabel="Open usage details"
              />
            )}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
  interact: (frame) => {
    const triggers = frame.ownerDocument.querySelectorAll<HTMLElement>(
      '[data-slot="dropdown-menu-sub-trigger"]'
    )
    const cursorRow = [...triggers].find((el) => el.textContent?.includes('Cursor'))
    cursorRow?.focus()
    cursorRow?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  }
})
