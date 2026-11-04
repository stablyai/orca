import React from 'react'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import type { HomeFleet } from './home-fleet-model'
import { HomeAgentRow } from './HomeAgentRow'
import { HomeCard, HomeCardEmpty } from './HomeCard'

const RELATIVE_TIME_TICK_MS = 30_000

export function HomeNeedsYouCard({ fleet }: { fleet: HomeFleet }): React.JSX.Element {
  const now = useNow(RELATIVE_TIME_TICK_MS)
  return (
    <HomeCard
      title={translate('auto.components.home.HomeFleetCards.needsYou', 'Needs you')}
      count={fleet.needsYou.length}
    >
      {fleet.needsYou.length === 0 ? (
        <HomeCardEmpty>
          {translate(
            'auto.components.home.HomeFleetCards.needsYouEmpty',
            'Nothing needs you right now.'
          )}
        </HomeCardEmpty>
      ) : (
        <div className="-mx-2 flex flex-col">
          {fleet.needsYou.map((card) => (
            <HomeAgentRow
              key={card.paneKey}
              card={card}
              since={card.stateChangedAt}
              now={now}
              detail={card.askSummary}
            />
          ))}
        </div>
      )}
    </HomeCard>
  )
}

export function HomeRunningNowCard({ fleet }: { fleet: HomeFleet }): React.JSX.Element {
  const now = useNow(RELATIVE_TIME_TICK_MS)
  return (
    <HomeCard
      title={translate('auto.components.home.HomeFleetCards.runningNow', 'Running now')}
      count={fleet.runningNow.length}
    >
      {fleet.runningNow.length === 0 ? (
        <HomeCardEmpty>
          {translate('auto.components.home.HomeFleetCards.runningNowEmpty', 'No agents running.')}
        </HomeCardEmpty>
      ) : (
        <div className="-mx-2 flex flex-col">
          {fleet.runningNow.map((card) => (
            <HomeAgentRow key={card.paneKey} card={card} since={card.startedAt} now={now} />
          ))}
        </div>
      )}
    </HomeCard>
  )
}
