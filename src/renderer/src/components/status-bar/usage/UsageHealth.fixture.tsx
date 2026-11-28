import { defineFixture } from '../../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CURSOR_MODELS_BUCKET_NAME } from '../../../../../shared/agent-usage/rate-limits/cursor-usage-buckets'
import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { StatusBarUsageMode } from '../../../../../shared/status-bar/status-bar-usage-mode'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { AccountSwitchList } from '../accounts/AccountSwitchList'
import { AccountSwitchRowItem } from '../accounts/AccountSwitchRowItem'
import { AccountUsageGauge, AccountUsageNotChecked } from '../accounts/AccountUsageGauge'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { ProviderIdentityCard } from '../accounts/ProviderIdentityCard'
import { ProviderSegment } from './StatusBarProviderSegment'
import { UsageRosterPanel } from './UsageRosterPanel'
import { ProviderPanel } from './provider-usage-panel'
import { UsageDisplayToggle } from './usage-meter'
import { useAppStore } from '../../../store'
import { normalizeUsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'

const NOW = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// Why null: a snapshot can carry only the Fable window, with no 5h/weekly reading yet.
type Preset = { s5: number | null; wk: number | null; fable: number }
const PRESETS = {
  healthy: { s5: 12, wk: 33, fable: 0 },
  low: { s5: 86, wk: 72, fable: 41 },
  full: { s5: 40, wk: 100, fable: 100 },
  fable: { s5: 12, wk: 33, fable: 100 },
  fableOnly: { s5: null, wk: null, fable: 100 },
  fableOnlyLow: { s5: null, wk: null, fable: 40 }
} satisfies Record<string, Preset>

function win(usedPercent: number, windowMinutes: number, resetsInMs: number): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes,
    resetsAt: NOW + resetsInMs + 5_000,
    resetDescription: null
  }
}

function base(provider: ProviderRateLimits['provider']): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: NOW - 30_000,
    error: null,
    status: 'ok'
  }
}

function claudeFor(preset: Preset): ProviderRateLimits {
  return {
    ...base('claude'),
    planType: 'max',
    session: preset.s5 === null ? null : win(preset.s5, 300, 3 * HOUR + 35 * MIN),
    weekly: preset.wk === null ? null : win(preset.wk, 10_080, 4 * DAY + 23 * HOUR),
    fableWeekly: win(preset.fable, 10_080, 4 * DAY + 23 * HOUR)
  }
}

function roster(preset: Preset, claudeExtra?: Partial<ProviderRateLimits>): ProviderRateLimits[] {
  return [
    {
      ...base('cursor'),
      planType: 'free',
      buckets: [{ ...win(64, 43_200, 12 * DAY), name: CURSOR_MODELS_BUCKET_NAME }]
    },
    { ...base('grok'), weekly: win(39, 10_080, 6 * DAY + 11 * HOUR) },
    {
      ...base('codex'),
      planType: 'pro',
      session: win(18, 300, 2 * HOUR),
      weekly: win(92, 10_080, 6 * DAY + 11 * HOUR)
    },
    { ...claudeFor(preset), ...claudeExtra },
    { ...base('opencode-go'), session: win(0, 300, 4 * HOUR + 58 * MIN) }
  ]
}

const noop = (): void => {}

// Why read the store: the header toggle flips the persisted setting, like the real status bar.
function useFixtureDisplay(): UsagePercentageDisplay {
  return normalizeUsagePercentageDisplay(useAppStore((s) => s.usagePercentageDisplay))
}

// Why: previews follow the live setting so flipping the Used/Left switch updates every number.
function LiveIdentityCard(
  props: Omit<React.ComponentProps<typeof ProviderIdentityCard>, 'usagePercentageDisplay'>
): React.JSX.Element {
  return <ProviderIdentityCard {...props} usagePercentageDisplay={useFixtureDisplay()} />
}

function LiveProviderPanel(
  props: Omit<React.ComponentProps<typeof ProviderPanel>, 'usagePercentageDisplay'>
): React.JSX.Element {
  return <ProviderPanel {...props} usagePercentageDisplay={useFixtureDisplay()} />
}

function LiveProviderSegment(
  props: Omit<React.ComponentProps<typeof ProviderSegment>, 'display'>
): React.JSX.Element {
  return <ProviderSegment {...props} display={useFixtureDisplay()} />
}

function RosterHarness({
  providers,
  mode,
  width
}: {
  providers: ProviderRateLimits[]
  mode: StatusBarUsageMode
  width: number
}): React.JSX.Element {
  const display = useFixtureDisplay()
  return (
    <div className="flex h-[520px] flex-col gap-3 bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap rounded border border-border px-2 py-1 text-xs">
        {providers
          .filter((p) => p.status !== 'unavailable')
          .map((p) => (
            <ProviderSegment key={p.provider} p={p} display={display} mode={mode} />
          ))}
      </div>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          variant="picker"
          className="w-[440px] max-w-[calc(100vw-1rem)]"
          style={{ maxWidth: width - 24 }}
        >
          <UsageRosterPanel
            providers={providers}
            display={display}
            statusBarUsageMode={mode}
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
  )
}

function rosterFixture(
  preset: Preset,
  display: UsagePercentageDisplay,
  mode: StatusBarUsageMode = 'verbose',
  width = 480,
  claudeExtra?: Partial<ProviderRateLimits>
) {
  const providers = roster(preset, claudeExtra)
  return defineFixture({
    width,
    store: { usagePercentageDisplay: display, statusBarUsageMode: mode },
    render: () => <RosterHarness providers={providers} mode={mode} width={width} />
  })
}

const OTHER_ACCOUNT: ProviderRateLimits = {
  ...base('claude'),
  session: win(16, 300, 3 * HOUR + 34 * MIN),
  weekly: win(100, 10_080, 3 * DAY + 11 * HOUR),
  fableWeekly: win(6, 10_080, 3 * DAY + 11 * HOUR)
}

// Why a component: the heading must re-render when a fixture switches the UI language.
function FixtureAccountList({ children }: { children: React.ReactNode }): React.JSX.Element {
  const t = useTranslate()
  return (
    <AccountSwitchList
      heading={t('auto.components.status.bar.AccountSwitchList.accounts', 'Accounts')}
    >
      {children}
    </AccountSwitchList>
  )
}

function cardFixture(preset: Preset, display: UsagePercentageDisplay) {
  const claude = claudeFor(preset)
  const accounts: {
    label: string
    active?: boolean
    usage: 'none' | 'unchecked' | ProviderRateLimits
  }[] = [
    { label: 'System default', usage: 'none' },
    { label: 'alpha@example.com', active: true, usage: claude },
    { label: 'bravo@example.com', usage: 'unchecked' },
    { label: 'charlie@example.com', usage: OTHER_ACCOUNT },
    { label: 'delta@example.com', usage: 'unchecked' }
  ]
  return defineFixture({
    width: 480,
    store: { usagePercentageDisplay: display },
    render: () => (
      <div className="h-[640px] bg-background p-3">
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>Claude</DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[440px] max-w-[calc(100vw-1rem)]">
            <div className="p-2">
              <LiveIdentityCard p={claude} accountLabel="alpha@example.com" inMenu />
            </div>
            <FixtureAccountList>
              {accounts.map((account) => (
                <AccountSwitchRowItem
                  key={account.label}
                  label={account.label}
                  active={account.active === true}
                  disabled={account.active === true}
                >
                  {account.usage === 'none' ? null : account.usage === 'unchecked' ? (
                    <AccountUsageNotChecked />
                  ) : (
                    <AccountUsageGauge limits={account.usage} isFetching={false} />
                  )}
                </AccountSwitchRowItem>
              ))}
            </FixtureAccountList>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  })
}

export const rosterHealthyUsed = rosterFixture(PRESETS.healthy, 'used')
export const rosterHealthyLeft = rosterFixture(PRESETS.healthy, 'remaining')
export const rosterLowUsed = rosterFixture(PRESETS.low, 'used')
export const rosterLowLeft = rosterFixture(PRESETS.low, 'remaining')
export const rosterFullUsed = rosterFixture(PRESETS.full, 'used')
export const rosterFullLeft = rosterFixture(PRESETS.full, 'remaining')
export const rosterFableUsed = rosterFixture(PRESETS.fable, 'used')
export const rosterFableLeft = rosterFixture(PRESETS.fable, 'remaining')
export const rosterHealthyCompact = rosterFixture(PRESETS.healthy, 'used', 'compact')
export const rosterLowCompact = rosterFixture(PRESETS.low, 'used', 'compact')
export const rosterNarrow300 = rosterFixture(PRESETS.low, 'used', 'compact', 324)

export const cardHealthyUsed = cardFixture(PRESETS.healthy, 'used')
export const cardHealthyLeft = cardFixture(PRESETS.healthy, 'remaining')
export const cardLowUsed = cardFixture(PRESETS.low, 'used')
export const cardLowLeft = cardFixture(PRESETS.low, 'remaining')
export const cardFullUsed = cardFixture(PRESETS.full, 'used')
export const cardFullLeft = cardFixture(PRESETS.full, 'remaining')
export const cardFableUsed = cardFixture(PRESETS.fable, 'used')
export const cardFableLeft = cardFixture(PRESETS.fable, 'remaining')

export const rosterToggleFocused = defineFixture({
  ...rosterFixture(PRESETS.low, 'used'),
  interact: (frame) => {
    const toggle = frame.ownerDocument.querySelector<HTMLElement>('[data-usage-display-toggle]')
    toggle?.focus()
    // Why Enter: proves the keyboard path flips the setting and the menu stays open.
    toggle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
})

function focusToggle(frame: HTMLElement): void {
  const toggle = frame.ownerDocument.querySelector<HTMLElement>('[data-usage-display-toggle]')
  toggle?.focus()
}

export const rosterFableOnly = rosterFixture(PRESETS.fableOnly, 'used', 'compact')
export const rosterFableOnlyDetailed = rosterFixture(PRESETS.fableOnly, 'used', 'verbose')
export const rosterFableOnlyNarrow300 = rosterFixture(PRESETS.fableOnly, 'used', 'compact', 324)
export const rosterFableNarrow300 = rosterFixture(PRESETS.fable, 'used', 'compact', 324)
export const rosterFullNarrow300 = rosterFixture(PRESETS.full, 'used', 'compact', 324)
export const rosterDetailedNarrow300 = rosterFixture(PRESETS.low, 'used', 'verbose', 324)
export const rosterFullCompact = rosterFixture(PRESETS.full, 'used', 'compact')

export const rosterGerman = defineFixture({
  ...rosterFixture(PRESETS.low, 'used'),
  interact: () => setRendererUiLanguage('de')
})

export const cardGerman = defineFixture({
  ...cardFixture(PRESETS.full, 'used'),
  interact: () => setRendererUiLanguage('de')
})

export const cardToggleFocused = defineFixture({
  ...cardFixture(PRESETS.low, 'used'),
  interact: focusToggle
})

export const providerPanelGrok = defineFixture({
  width: 480,
  render: () => (
    <div className="h-[260px] bg-background p-3">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Grok</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[440px] max-w-[calc(100vw-1rem)]">
          <div className="p-2">
            <LiveProviderPanel
              p={{
                ...base('grok'),
                session: win(84, 300, 2 * HOUR + 10 * MIN),
                weekly: win(39, 10_080, 6 * DAY + 11 * HOUR)
              }}
              headerAction={<UsageDisplayToggle asMenuItem />}
            />
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

export const cardExtraUsageLeft = defineFixture({
  width: 480,
  store: { usagePercentageDisplay: 'remaining' },
  render: () => (
    <div className="h-[380px] bg-background p-3">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>Claude</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[440px] max-w-[calc(100vw-1rem)]">
          <div className="p-2">
            <LiveIdentityCard
              p={{
                ...claudeFor(PRESETS.healthy),
                extraUsage: {
                  unit: 'currency',
                  enabled: true,
                  disabledReason: null,
                  resetsAt: null,
                  balance: 75,
                  currencyCode: 'USD',
                  spent: 25,
                  spendLimit: 100,
                  spentPercent: 25
                }
              }}
              accountLabel="alpha@example.com"
              inMenu
            />
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

export const statusBarFableOnly = defineFixture({
  width: 420,
  render: () => (
    <div className="flex flex-col gap-2 bg-background p-3 text-xs">
      {(['verbose', 'compact'] as const).map((mode) => (
        <div key={mode} className="flex items-center gap-3">
          <span className="w-40 text-muted-foreground">{mode}</span>
          <LiveProviderSegment p={claudeFor(PRESETS.fableOnly)} mode={mode} />
        </div>
      ))}
    </div>
  )
})

// Why: a failed refresh keeps the stored reading; the row must keep showing it.
const REFRESH_FAILED: Partial<ProviderRateLimits> = {
  status: 'error',
  error: 'Network error'
}
export const rosterFableRefreshError = rosterFixture(
  PRESETS.fable,
  'used',
  'verbose',
  480,
  REFRESH_FAILED
)
export const rosterFableOnlyRefreshError = rosterFixture(
  PRESETS.fableOnly,
  'used',
  'compact',
  480,
  REFRESH_FAILED
)

export const rosterFableOnlyLow = rosterFixture(PRESETS.fableOnlyLow, 'used', 'compact')
export const rosterFableOnlyLowDetailed = rosterFixture(PRESETS.fableOnlyLow, 'used', 'verbose')

// Why: native title tooltips never paint in a screenshot, so print each Fable title under the roster.
function revealFableTitles(frame: HTMLElement): void {
  const doc = frame.ownerDocument
  const titles = [
    ...doc.querySelectorAll<HTMLElement>(
      '[data-usage-scoped-only],[data-usage-scoped-urgent],[data-usage-window][title]'
    )
  ]
    .map((element) => element.title)
    .filter(Boolean)
  doc.querySelector('[data-fixture-titles]')?.remove()
  const note = doc.createElement('pre')
  note.setAttribute('data-fixture-titles', '')
  note.style.cssText =
    'position:fixed;left:12px;bottom:12px;padding:6px 8px;border:1px dashed currentColor;font:12px ui-monospace,monospace;z-index:99999;background:var(--background);color:var(--foreground)'
  note.textContent = `title: ${titles.join('\ntitle: ') || '(none)'}`
  doc.body.appendChild(note)
}

export const rosterFableTitleUsed = defineFixture({
  ...rosterFixture(PRESETS.fableOnly, 'used', 'compact'),
  interact: revealFableTitles
})
export const rosterFableTitleLeft = defineFixture({
  ...rosterFixture(PRESETS.fable, 'remaining', 'verbose'),
  interact: revealFableTitles
})
