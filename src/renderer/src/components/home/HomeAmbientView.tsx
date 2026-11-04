import React, { useEffect } from 'react'
import { useNow } from '@/hooks/use-now'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { Button } from '../ui/button'
import { barColor } from '../status-bar/tooltip'
import { getTightestUsageSection } from '../status-bar/UsageRosterPanel'
import { getProviderDisplayName } from '../status-bar/usage-error-copy'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage
} from '../../../../shared/usage-percentage-display'
import { formatFleetSummary, type HomeFleet } from './home-fleet-model'
import { useHomeUsageProviders } from './use-home-usage-providers'

const CLOCK_TICK_MS = 10_000
const RECENTLY_FINISHED_LIMIT = 5

function AmbientUsageBars(): React.JSX.Element | null {
  const { rosterProviders, usagePercentageDisplay } = useHomeUsageProviders()
  const rows = rosterProviders.flatMap((p) => {
    const section = getTightestUsageSection(p)
    return section ? [{ provider: p.provider, section }] : []
  })
  if (rows.length === 0) {
    return null
  }
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      {rows.map(({ provider, section }) => {
        const used = clampUsedPercent(section.window.usedPercent)
        const shown = getDisplayedUsagePercentage(
          section.window.usedPercent,
          usagePercentageDisplay
        )
        return (
          <div key={provider} className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="w-24 truncate">{getProviderDisplayName(provider)}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full ${barColor(used)}`}
                style={{ width: `${shown}%` }}
              />
            </span>
            <span className="w-10 text-right tabular-nums">{shown}%</span>
          </div>
        )
      })}
    </div>
  )
}

/** Low-density resting layout; shows only counts and names so it is safe on shared screens. */
export function HomeAmbientView({
  fleet,
  onExit
}: {
  fleet: HomeFleet
  onExit: () => void
}): React.JSX.Element {
  const now = useNow(CLOCK_TICK_MS)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onExit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  const clock = new Intl.DateTimeFormat(getIntlLocale(), {
    hour: '2-digit',
    minute: '2-digit'
  }).format(now)
  const recentlyFinished = fleet.recentlyFinished.slice(0, RECENTLY_FINISHED_LIMIT)

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-8 bg-background px-6 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500">
      <p className="text-7xl font-light tabular-nums tracking-tight text-foreground">{clock}</p>
      <p className="text-sm text-muted-foreground">{formatFleetSummary(fleet.counts)}</p>
      <AmbientUsageBars />
      {recentlyFinished.length > 0 ? (
        <div className="flex w-full max-w-sm flex-col gap-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {translate(
              'auto.components.home.HomeAmbientView.recentlyFinished',
              'Recently finished'
            )}
          </p>
          {recentlyFinished.map((card) => (
            <div
              key={card.paneKey}
              className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
            >
              <AgentTypeIcon agentType={card.agentType} size={12} />
              <span className="shrink-0 text-foreground/80">
                {formatAgentTypeLabel(card.agentType)}
              </span>
              <span className="min-w-0 truncate">
                {card.repoName} · {card.worktreeName}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <Button variant="ghost" size="sm" onClick={onExit} className="text-muted-foreground">
        {translate('auto.components.home.HomeAmbientView.exit', 'Exit rest mode')}
      </Button>
    </div>
  )
}
