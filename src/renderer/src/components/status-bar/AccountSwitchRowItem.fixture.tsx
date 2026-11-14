import { defineFixture } from '../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AccountSwitchList } from './AccountSwitchList'
import { AccountSwitchRowItem } from './AccountSwitchRowItem'
import { InlineUsageBars } from './InlineProviderUsage'

function accountRows(provider: 'codex' | 'claude', width = 520, language: 'en' | 'ru' = 'en') {
  const limits: ProviderRateLimits = {
    provider,
    session: {
      usedPercent: 100,
      windowMinutes: 300,
      resetsAt: Date.now() + 80 * 60_000 + 5_000,
      resetDescription: null
    },
    weekly: {
      usedPercent: 38,
      windowMinutes: 10_080,
      resetsAt: Date.now() + (6 * 24 + 4) * 3_600_000 + 5_000,
      resetDescription: null
    },
    fableWeekly:
      provider === 'claude'
        ? {
            usedPercent: 42,
            windowMinutes: 10_080,
            resetsAt: Date.now() + 43 * 3_600_000 + 5_000,
            resetDescription: null
          }
        : null,
    updatedAt: 0,
    error: null,
    status: 'ok'
  }
  return defineFixture({
    width,
    interact: () => setRendererUiLanguage(language),
    render: () => (
      <div className="h-[340px] bg-background p-3">
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>Accounts</DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[400px] max-w-[calc(100vw-1rem)]"
            style={{ maxWidth: width - 24 }}
            align="start"
          >
            <AccountSwitchList heading={provider === 'codex' ? 'Codex Account' : 'Claude Account'}>
              {['2cdb7eb6', '9a41e0d3'].map((id, index) => (
                <AccountSwitchRowItem
                  key={id}
                  label={`longaccountemail@example.com (Personal (Pro) · ${id})`}
                  active={index === 0}
                  disabled={index === 0}
                >
                  <InlineUsageBars limits={limits} isFetching={false} />
                </AccountSwitchRowItem>
              ))}
            </AccountSwitchList>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  })
}

export const codex = accountRows('codex')
export const claude = accountRows('claude')
export const narrowCodex = accountRows('codex', 336)
export const narrowClaude = accountRows('claude', 336)
export const russianCodex = accountRows('codex', 390, 'ru')
export const russianClaude = accountRows('claude', 390, 'ru')
