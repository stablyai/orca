import { useEffect } from 'react'
import {
  Activity,
  DatabaseZap,
  FolderKanban,
  RefreshCw,
  SlidersHorizontal,
  Sparkles
} from 'lucide-react'
import type { KimiUsageRange, KimiUsageScope } from '../../../../shared/kimi-usage-types'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { ClaudeUsageLoadingState } from './ClaudeUsageLoadingState'
import { KimiUsageDetails } from './KimiUsageDetails'
import { StatCard } from './StatCard'
import { formatTokens, formatUpdatedAt } from './usage-formatters'
import { translate } from '@/i18n/i18n'

const RANGE_OPTIONS: KimiUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: KimiUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.KimiUsagePane.scopeOrca', 'Orca worktrees only')
    }
  },
  {
    value: 'all',
    get label() {
      return translate('auto.components.stats.KimiUsagePane.scopeAll', 'All local Kimi Code usage')
    }
  }
]
const RANGE_LABELS: Record<KimiUsageRange, string> = {
  get '7d'() {
    return translate('auto.components.stats.KimiUsagePane.range7d', 'Last 7 days')
  },
  get '30d'() {
    return translate('auto.components.stats.KimiUsagePane.range30d', 'Last 30 days')
  },
  get '90d'() {
    return translate('auto.components.stats.KimiUsagePane.range90d', 'Last 90 days')
  },
  get all() {
    return translate('auto.components.stats.KimiUsagePane.rangeAll', 'All time')
  }
}

export function KimiUsagePane(): React.JSX.Element {
  const scanState = useAppStore((state) => state.kimiUsageScanState)
  const summary = useAppStore((state) => state.kimiUsageSummary)
  const daily = useAppStore((state) => state.kimiUsageDaily)
  const modelBreakdown = useAppStore((state) => state.kimiUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.kimiUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.kimiUsageRecentSessions)
  const scope = useAppStore((state) => state.kimiUsageScope)
  const range = useAppStore((state) => state.kimiUsageRange)
  const fetchKimiUsage = useAppStore((state) => state.fetchKimiUsage)
  const setKimiUsageEnabled = useAppStore((state) => state.setKimiUsageEnabled)
  const refreshKimiUsage = useAppStore((state) => state.refreshKimiUsage)
  const setKimiUsageScope = useAppStore((state) => state.setKimiUsageScope)
  const setKimiUsageRange = useAppStore((state) => state.setKimiUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => {
    void fetchKimiUsage()
  }, [fetchKimiUsage])

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setKimiUsageEnabled(enabled)
  }

  const paneTitle = translate(
    'auto.components.stats.KimiUsagePane.title',
    'Kimi Code Usage Tracking'
  )

  if (!scanState?.enabled) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.stats.KimiUsagePane.description',
                'Reads local Kimi Code usage logs to show token, model, and session stats.'
              )}
            </p>
          </div>
          <Switch
            checked={false}
            aria-label={translate(
              'auto.components.stats.KimiUsagePane.enable',
              'Enable Kimi Code usage analytics'
            )}
            onCheckedChange={handleSetEnabled}
          />
        </div>
      </div>
    )
  }

  if (!summary && (scanState.isScanning || scanState.lastScanCompletedAt === null)) {
    return (
      <ClaudeUsageLoadingState
        title={paneTitle}
        summaryCardCount={5}
        summaryGridClassName="md:grid-cols-3"
      />
    )
  }

  const hasAnyData = summary?.hasAnyKimiData ?? scanState.hasAnyKimiData

  return (
    <div className="space-y-4 rounded-lg border border-border/60 bg-card/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatUpdatedAt(scanState.lastScanCompletedAt)}
            {scanState.lastScanError
              ? translate(
                  'auto.components.stats.KimiUsagePane.scanError',
                  ' — Last scan error: {{value0}}',
                  {
                    value0: scanState.lastScanError
                  }
                )
              : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <DropdownMenu>
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={translate(
                        'auto.components.stats.KimiUsagePane.options',
                        'Kimi Code usage options'
                      )}
                    >
                      <SlidersHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.components.stats.KimiUsagePane.filters', 'Filters')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>
                {translate('auto.components.stats.KimiUsagePane.scope', 'Scope')}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={scope}
                onValueChange={(value) => void setKimiUsageScope(value as KimiUsageScope)}
              >
                {SCOPE_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                {translate('auto.components.stats.KimiUsagePane.range', 'Range')}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={range}
                onValueChange={(value) => void setKimiUsageRange(value as KimiUsageRange)}
              >
                {RANGE_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    {RANGE_LABELS[option]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void refreshKimiUsage()}
                  disabled={scanState.isScanning}
                  aria-label={translate(
                    'auto.components.stats.KimiUsagePane.refresh',
                    'Refresh Kimi Code usage'
                  )}
                >
                  <RefreshCw className={`size-3.5 ${scanState.isScanning ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate('auto.components.stats.KimiUsagePane.refreshLabel', 'Refresh')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Switch
            checked
            aria-label={translate(
              'auto.components.stats.KimiUsagePane.enable',
              'Enable Kimi Code usage analytics'
            )}
            onCheckedChange={handleSetEnabled}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} — {RANGE_LABELS[range]}
        </p>
      </div>

      {!hasAnyData ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.stats.KimiUsagePane.noData',
            'No local Kimi Code usage found yet for this scope.'
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <StatCard
              label={translate('auto.components.stats.KimiUsagePane.inputTokens', 'Input tokens')}
              value={formatTokens(summary?.inputTokens ?? 0)}
              icon={<Sparkles className="size-4" />}
            />
            <StatCard
              label={translate('auto.components.stats.KimiUsagePane.outputTokens', 'Output tokens')}
              value={formatTokens(summary?.outputTokens ?? 0)}
              icon={<Activity className="size-4" />}
            />
            <StatCard
              label={translate('auto.components.stats.KimiUsagePane.cacheRead', 'Cache read')}
              value={formatTokens(summary?.cachedInputTokens ?? 0)}
              icon={<DatabaseZap className="size-4" />}
            />
            <StatCard
              label={translate(
                'auto.components.stats.KimiUsagePane.cacheCreation',
                'Cache creation'
              )}
              value={formatTokens(summary?.cacheCreationTokens ?? 0)}
              icon={<DatabaseZap className="size-4" />}
            />
            <StatCard
              label={translate('auto.components.stats.KimiUsagePane.sessions', 'Sessions / Events')}
              value={`${(summary?.sessions ?? 0).toLocaleString()} / ${(summary?.events ?? 0).toLocaleString()}`}
              icon={<FolderKanban className="size-4" />}
            />
          </div>

          <KimiUsageDetails
            daily={daily}
            modelBreakdown={modelBreakdown}
            projectBreakdown={projectBreakdown}
            recentSessions={recentSessions}
            summary={summary}
          />
        </>
      )}
    </div>
  )
}
