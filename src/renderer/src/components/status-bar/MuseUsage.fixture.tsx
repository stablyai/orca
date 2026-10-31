import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { AppState } from '../../store/types'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ProviderSegment } from './StatusBarProviderSegment'
import { StatusBarSurface } from './StatusBarSurface'
import { UsageRow } from './UsageRosterPanel'
import { getUsageRosterRowState } from './usage-roster-row-state'

const fixtureNow = Date.now()

const muse: ProviderRateLimits = {
  provider: 'muse',
  session: {
    usedPercent: 25,
    windowMinutes: 300,
    resetsAt: fixtureNow + 2 * 60 * 60_000,
    resetDescription: null
  },
  weekly: {
    usedPercent: 60,
    windowMinutes: 10_080,
    resetsAt: fixtureNow + 3 * 24 * 60 * 60_000,
    resetDescription: null
  },
  planType: 'Muse Code High Usage',
  updatedAt: fixtureNow,
  error: null,
  status: 'ok',
  usageMetadata: { source: 'cli' }
}

const noAllowance: ProviderRateLimits = {
  ...muse,
  session: null,
  weekly: null,
  status: 'unavailable',
  error: 'Muse did not report a usage allowance.',
  usageMetadata: { source: 'cli', failureKind: 'usage-unavailable' }
}

export const chip = defineFixture({
  width: 360,
  render: () => <ProviderSegment p={muse} compact={false} display="used" />
})

export const unavailableChip = defineFixture({
  width: 360,
  render: () => <ProviderSegment p={noAllowance} compact={false} display="used" />
})

function RosterRow({ provider }: { provider: ProviderRateLimits }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-popover px-3.5 py-2.5 text-popover-foreground">
      <UsageRow
        p={provider}
        display="used"
        state={getUsageRosterRowState(provider, provider.session !== null)}
        showSignInAction={false}
        now={fixtureNow}
      />
    </div>
  )
}

export const roster = defineFixture({ width: 360, render: () => <RosterRow provider={muse} /> })

export const unavailableRoster = defineFixture({
  width: 360,
  render: () => <RosterRow provider={noAllowance} />
})

const kimi: ProviderRateLimits = { ...muse, provider: 'kimi', planType: null }

function footerStore(includeMuse: boolean): Partial<AppState> {
  return {
    rateLimits: createEmptyRateLimitState({ kimi, muse: includeMuse ? muse : null }),
    detectedAgentIds: ['kimi', 'muse'],
    ensureDetectedAgents: async () => ['kimi', 'muse'],
    statusBarItems: includeMuse ? ['kimi', 'muse'] : ['kimi'],
    statusBarVisible: true,
    statusBarUsageMode: 'verbose',
    usagePercentageDisplay: 'used',
    usagePercentageDisplayChangeNoticeDismissed: true,
    statusBarCompactChangeNoticeDismissed: true
  }
}

const renderFooter = (): React.JSX.Element => <StatusBarSurface floatingTerminalOpen={false} />

export const beforeFooter = defineFixture({
  width: 1280,
  store: footerStore(false),
  render: renderFooter
})

export const afterFooter = defineFixture({
  width: 1280,
  store: footerStore(true),
  render: renderFooter
})

const openUsage = async (frame: HTMLElement): Promise<void> => {
  const trigger = frame.querySelector<HTMLButtonElement>('button[aria-label="Usage"]')
  if (!trigger) {
    throw new Error('Usage trigger is missing')
  }
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (!document.querySelector('[role="menu"]')) {
    throw new Error('Usage menu did not open')
  }
}

export const beforeMenu = defineFixture({
  width: 1280,
  store: footerStore(false),
  render: renderFooter,
  interact: openUsage
})

export const afterMenu = defineFixture({
  width: 1280,
  store: footerStore(true),
  render: renderFooter,
  interact: openUsage
})
