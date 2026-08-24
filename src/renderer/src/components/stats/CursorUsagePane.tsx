import { useState } from 'react'
import { CalendarClock, ExternalLink, RefreshCw, Sparkles } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { StatCard } from './StatCard'
import { formatUpdatedAt } from './usage-formatters'

export function CursorUsagePane(): React.JSX.Element {
  const cursor = useAppStore((s) => s.rateLimits.cursor)
  const cursorAuthConfigured = useAppStore((s) => s.rateLimits.cursorAuthConfigured)
  const refreshCursorRateLimits = useAppStore((s) => s.refreshCursorRateLimits)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleRefresh = (): void => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    void refreshCursorRateLimits().finally(() => setIsRefreshing(false))
  }

  const openCursorAccounts = (): void => {
    openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-cursor' })
    openSettingsPage()
  }

  const paneTitle = translate('auto.components.stats.CursorUsagePane.c1d2e3f4a5', 'Cursor usage')

  if (!cursorAuthConfigured) {
    return (
      <div
        className="rounded-lg border border-border/60 bg-card/40 p-4"
        data-testid="cursor-usage-pane"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.stats.CursorUsagePane.b6c7d8e9f0',
                'Plan usage from your Cursor IDE sign-in (globalStorage state database). Same source as the status bar.'
              )}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              recordFeatureInteraction('usage-tracking')
              openCursorAccounts()
            }}
          >
            {translate('auto.components.stats.CursorUsagePane.c7d8e9f0a1', 'Set up in Accounts')}
          </Button>
        </div>
      </div>
    )
  }

  const monthlyPercent =
    cursor?.monthly && typeof cursor.monthly.usedPercent === 'number'
      ? Math.round(cursor.monthly.usedPercent)
      : null
  const autoPercent = (() => {
    const used = cursor?.buckets?.find((b) => b.name === 'Auto')?.usedPercent
    return typeof used === 'number' ? Math.round(used) : null
  })()
  const apiPercent = (() => {
    const used = cursor?.buckets?.find((b) => b.name === 'API')?.usedPercent
    return typeof used === 'number' ? Math.round(used) : null
  })()
  const isFetching = isRefreshing || cursor?.status === 'fetching'

  return (
    <div
      className="space-y-4 rounded-lg border border-border/60 bg-card/30 p-4"
      data-testid="cursor-usage-pane"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatUpdatedAt(cursor?.updatedAt ?? null)}
            {cursor?.error
              ? translate('auto.components.stats.CursorUsagePane.d8e9f0a1b2', ' • {{value0}}', {
                  value0: cursor.error
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
                    'auto.components.stats.CursorUsagePane.e9f0a1b2c3',
                    'Refresh Cursor usage'
                  )}
                >
                  <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate('auto.components.stats.CursorUsagePane.f0a1b2c3d4', 'Refresh')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={translate('auto.components.stats.CursorUsagePane.a1b2c3d4e5', 'Plan usage')}
          value={monthlyPercent !== null ? `${monthlyPercent}%` : '—'}
          icon={<Sparkles className="size-4" />}
        />
        <StatCard
          label={translate('auto.components.stats.CursorUsagePane.a8b9c0d1e2', 'Auto')}
          value={autoPercent !== null ? `${autoPercent}%` : '—'}
          icon={<Sparkles className="size-4" />}
        />
        <StatCard
          label={translate('auto.components.stats.CursorUsagePane.b9c0d1e2f3', 'API')}
          value={apiPercent !== null ? `${apiPercent}%` : '—'}
          icon={<Sparkles className="size-4" />}
        />
        <StatCard
          label={translate(
            'auto.components.stats.CursorUsagePane.b2c3d4e5f6',
            'Billing period reset'
          )}
          value={cursor?.monthly?.resetDescription ?? '—'}
          icon={<CalendarClock className="size-4" />}
        />
      </div>

      {cursor?.usageMetadata?.authProvenance ? (
        <p className="px-1 text-xs text-muted-foreground">{cursor.usageMetadata.authProvenance}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-auto gap-1 px-0 text-xs"
          onClick={openCursorAccounts}
        >
          {translate('auto.components.stats.CursorUsagePane.c3d4e5f6a7', 'Cursor account settings')}
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </div>
  )
}
