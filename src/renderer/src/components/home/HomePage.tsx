import React, { useCallback, useMemo, useState } from 'react'
import { Moon } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import { useLiveDashboardSnapshot } from '../dashboard/useLiveDashboardSnapshot'
import { buildHomeFleet, formatFleetSummary } from './home-fleet-model'
import { HomeActivityCard } from './HomeActivityCard'
import { HomeNeedsYouCard, HomeRunningNowCard } from './HomeFleetCards'
import { HomeUsageCard } from './HomeUsageCard'
import { HomeLandingFooter } from './HomeLandingFooter'
import { HomeAmbientView } from './HomeAmbientView'

export default function HomePage({
  asLanding = false
}: {
  /** Shown in place of Landing when no workspace is selected. */
  asLanding?: boolean
}): React.JSX.Element {
  // Why: one snapshot subscription for the whole page; it reads many store slices.
  const snapshot = useLiveDashboardSnapshot()
  const fleet = useMemo(() => buildHomeFleet(snapshot.cards), [snapshot.cards])
  const [resting, setResting] = useState(false)
  const exitRest = useCallback(() => setResting(false), [])

  return (
    // Why: rest mode sits outside the scroller so it always covers the visible page.
    <div className="relative flex h-full min-h-0 flex-1">
      <main
        inert={resting}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek bg-background pt-5 text-foreground md:pt-6"
      >
        <header
          className="flex shrink-0 items-center gap-3 px-3 pb-3 md:px-5"
          style={{ paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))' }}
        >
          <h1 className="truncate text-base font-semibold leading-8">
            {translate('auto.components.home.HomePage.title', 'Home')}
          </h1>
          <span className="truncate text-xs text-muted-foreground">
            {formatFleetSummary(fleet.counts)}
          </span>
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setResting(true)}>
            <Moon />
            {translate('auto.components.home.HomePage.restMode', 'Rest mode')}
          </Button>
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
      {resting ? <HomeAmbientView fleet={fleet} onExit={exitRest} /> : null}
    </div>
  )
}
