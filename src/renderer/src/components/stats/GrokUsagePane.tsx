import { useState } from 'react'
import { CalendarClock, ExternalLink, RefreshCw, Sparkles } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { StatCard } from './StatCard'
import { formatUpdatedAt } from './usage-formatters'

export function GrokUsagePane(): React.JSX.Element {
  const grok = useAppStore((s) => s.rateLimits.grok)
  const grokAuthConfigured = useAppStore((s) => s.rateLimits.grokAuthConfigured)
  const refreshGrokRateLimits = useAppStore((s) => s.refreshGrokRateLimits)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  // Why: settled snapshots keep their status during refetches (no 'fetching'
  // repaint), so manual-refresh feedback must be renderer-local, matching the
  // StatusBar refresh button.
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleRefresh = (): void => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    void refreshGrokRateLimits().finally(() => setIsRefreshing(false))
  }

  const openGrokAccounts = (): void => {
    openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-grok' })
    openSettingsPage()
  }

  const paneTitle = translate('auto.components.stats.GrokUsagePane.g8h9i0j1k2', 'Grok usage')

  if (!grokAuthConfigured) {
    return (
      <div
        className="rounded-lg border border-border/60 bg-card/40 p-4"
        data-testid="grok-usage-pane"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.stats.GrokUsagePane.b2d3e4f5c6',
                'Weekly subscription credits from Grok CLI OAuth (~/.grok/auth.json). Same source as the status bar.'
              )}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              recordFeatureInteraction('usage-tracking')
              openGrokAccounts()
            }}
          >
            {translate('auto.components.stats.GrokUsagePane.c3e4f5a6b7', 'Set up in Accounts')}
          </Button>
        </div>
      </div>
    )
  }

  const weeklyPercent =
    grok?.weekly && typeof grok.weekly.usedPercent === 'number'
      ? Math.round(grok.weekly.usedPercent)
      : null
  const isFetching = isRefreshing || grok?.status === 'fetching'

  return (
    <div
      className="space-y-4 rounded-lg border border-border/60 bg-card/30 p-4"
      data-testid="grok-usage-pane"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatUpdatedAt(grok?.updatedAt ?? null)}
            {grok?.error
              ? translate('auto.components.stats.GrokUsagePane.h9i0j1k2l3', ' • {{value0}}', {
                  value0: grok.error
                })
              : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleRefresh}
                  disabled={isFetching}
                  aria-label={translate(
                    'auto.components.stats.GrokUsagePane.i0j1k2l3m4',
                    'Refresh Grok usage'
                  )}
                >
                  <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate('auto.components.stats.GrokUsagePane.d4f5a6b7c8', 'Refresh')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <StatCard
          label={translate('auto.components.stats.GrokUsagePane.e5a6b7c8d9', 'Weekly credits used')}
          value={weeklyPercent !== null ? `${weeklyPercent}%` : '—'}
          icon={<Sparkles className="size-4" />}
        />
        <StatCard
          label={translate(
            'auto.components.stats.GrokUsagePane.f6b7c8d9e0',
            'Billing period reset'
          )}
          value={grok?.weekly?.resetDescription ?? '—'}
          icon={<CalendarClock className="size-4" />}
        />
      </div>

      {grok?.usageMetadata?.authProvenance ? (
        <p className="px-1 text-xs text-muted-foreground">{grok.usageMetadata.authProvenance}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-auto gap-1 px-0 text-xs"
          onClick={openGrokAccounts}
        >
          {translate('auto.components.stats.GrokUsagePane.a7b8c9d0e1', 'Grok account settings')}
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </div>
  )
}
