import React from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { Button } from '../ui/button'
import { getWindowSections } from '../status-bar/tooltip'
import { getTightestUsageSection, UsageRow } from '../status-bar/UsageRosterPanel'
import { getUsageRosterRowState } from '../status-bar/usage-roster-row-state'
import { HomeCard, HomeCardEmpty } from './HomeCard'
import { useHomeUsageProviders } from './use-home-usage-providers'

export function useOpenStatsSettings(): () => void {
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  return () => {
    openSettingsTarget({ pane: 'stats', repoId: null })
    openSettingsPage()
  }
}

export function HomeUsageCard(): React.JSX.Element {
  const { rosterProviders, usagePercentageDisplay } = useHomeUsageProviders()
  const openStatsSettings = useOpenStatsSettings()
  const now = useResetCountdownClock(
    rosterProviders.flatMap((p) => getWindowSections(p).map((section) => section.window?.resetsAt))
  )

  return (
    <HomeCard
      title={translate('auto.components.home.HomeUsageCard.title', 'Usage & limits')}
      action={
        <Button variant="ghost" size="xs" onClick={openStatsSettings}>
          {translate('auto.components.home.HomeUsageCard.details', 'Details')}
        </Button>
      }
    >
      {rosterProviders.length === 0 ? (
        <HomeCardEmpty>
          {translate(
            'auto.components.home.HomeUsageCard.empty',
            'No usage providers set up. Open Details to connect one.'
          )}
        </HomeCardEmpty>
      ) : (
        <div className="flex flex-col gap-3">
          {rosterProviders.map((p) => (
            <UsageRow
              key={p.provider}
              p={p}
              display={usagePercentageDisplay}
              state={getUsageRosterRowState(p, getTightestUsageSection(p) !== null)}
              showSignInAction={false}
              now={now}
              mode="verbose"
            />
          ))}
        </div>
      )}
    </HomeCard>
  )
}
