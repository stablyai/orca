import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useLiveDashboardSnapshot } from '../dashboard/useLiveDashboardSnapshot'
import { buildHomeFleet, type HomeFleet } from './home-fleet-model'
import { HomeActivityCard } from './HomeActivityCard'
import { HomeNeedsYouCard, HomeRunningNowCard } from './HomeFleetCards'
import { HomeUsageCard } from './HomeUsageCard'
import { HomeLandingFooter } from './HomeLandingFooter'

export function formatFleetSummary(counts: HomeFleet['counts']): string {
  return translate(
    'auto.components.home.HomePage.fleetSummary',
    '{{working}} working · {{attention}} needs you · {{done}} done',
    counts
  )
}

export default function HomePage({
  asLanding = false
}: {
  /** Shown in place of Landing when no workspace is selected. */
  asLanding?: boolean
}): React.JSX.Element {
  // Why: one snapshot subscription for the whole page; it reads many store slices.
  const snapshot = useLiveDashboardSnapshot()
  const fleet = useMemo(() => buildHomeFleet(snapshot.cards), [snapshot.cards])

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek bg-background pt-5 text-foreground md:pt-6">
      <header
        className="flex shrink-0 items-baseline gap-3 px-3 pb-3 md:px-5"
        style={
          {
            paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))'
          } as React.CSSProperties
        }
      >
        <h1 className="truncate text-base font-semibold leading-8">
          {translate('auto.components.home.HomePage.title', 'Home')}
        </h1>
        <span className="truncate text-xs text-muted-foreground">
          {formatFleetSummary(fleet.counts)}
        </span>
      </header>
      <div className="flex-1 px-3 pb-6 md:px-5">
        <div className="grid gap-4 md:grid-cols-2">
          <HomeNeedsYouCard fleet={fleet} />
          <HomeRunningNowCard fleet={fleet} />
          <HomeUsageCard />
          <HomeActivityCard />
        </div>
      </div>
      {asLanding ? <HomeLandingFooter /> : null}
    </main>
  )
}
