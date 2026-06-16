import { useEffect } from 'react'
import {
  Activity,
  Brain,
  Coins,
  DatabaseZap,
  FolderKanban,
  RefreshCw,
  SlidersHorizontal,
  Sparkles
} from 'lucide-react'
import type { CodexUsageRange, CodexUsageScope } from '../../../../shared/codex-usage-types'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
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
import { CodexUsageDetails } from './CodexUsageDetails'
import { ShareUsageButton } from './ShareUsageButton'
import { StatCard } from './StatCard'
import { formatCost, formatTokens, formatUpdatedAt } from './usage-formatters'
import { translate } from '@/i18n/i18n'

const RANGE_OPTIONS: CodexUsageRange[] = ['7d', '30d', '90d', 'all']
const SCOPE_OPTIONS: { value: CodexUsageScope; label: string }[] = [
  {
    value: 'orca',
    get label() {
      return translate('auto.components.stats.CodexUsagePane.201766b754', 'Orca worktrees only')
    }
  },
  {
    value: 'all',
    get label() {
      return translate('auto.components.stats.CodexUsagePane.4fe8820098', 'All local Codex usage')
    }
  }
]
const RANGE_LABELS: Record<CodexUsageRange, string> = {
  get '7d'() {
    return translate('auto.components.stats.CodexUsagePane.rangeLast7Days', 'Last 7 days')
  },
  get '30d'() {
    return translate('auto.components.stats.CodexUsagePane.rangeLast30Days', 'Last 30 days')
  },
  get '90d'() {
    return translate('auto.components.stats.CodexUsagePane.rangeLast90Days', 'Last 90 days')
  },
  get all() {
    return translate('auto.components.stats.CodexUsagePane.rangeAllTime', 'All time')
  }
}

export function CodexUsagePane(): React.JSX.Element {
  const scanState = useAppStore((state) => state.codexUsageScanState)
  const summary = useAppStore((state) => state.codexUsageSummary)
  const daily = useAppStore((state) => state.codexUsageDaily)
  const modelBreakdown = useAppStore((state) => state.codexUsageModelBreakdown)
  const projectBreakdown = useAppStore((state) => state.codexUsageProjectBreakdown)
  const recentSessions = useAppStore((state) => state.codexUsageRecentSessions)
  const scope = useAppStore((state) => state.codexUsageScope)
  const range = useAppStore((state) => state.codexUsageRange)
  const fetchCodexUsage = useAppStore((state) => state.fetchCodexUsage)
  const setCodexUsageEnabled = useAppStore((state) => state.setCodexUsageEnabled)
  const refreshCodexUsage = useAppStore((state) => state.refreshCodexUsage)
  const setCodexUsageScope = useAppStore((state) => state.setCodexUsageScope)
  const setCodexUsageRange = useAppStore((state) => state.setCodexUsageRange)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)

  useEffect(() => {
    void fetchCodexUsage()
  }, [fetchCodexUsage])

  const handleSetEnabled = (enabled: boolean): void => {
    recordFeatureInteraction('usage-tracking')
    void setCodexUsageEnabled(enabled)
  }

  if (!scanState?.enabled) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              {translate('auto.components.stats.CodexUsagePane.408210470c', 'Codex Usage Tracking')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.stats.CodexUsagePane.13badcd8f2',
                'Reads local Codex usage logs to show token, model, and session stats.'
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={false}
            aria-label={translate(
              'auto.components.stats.CodexUsagePane.f7c1affbd5',
              'Enable Codex usage analytics'
            )}
            onClick={() => handleSetEnabled(true)}
            className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-muted-foreground/30 transition-colors"
          >
            <span className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform" />
          </button>
        </div>
      </div>
    )
  }

  if (!summary && (scanState.isScanning || scanState.lastScanCompletedAt === null)) {
    return (
      <ClaudeUsageLoadingState
        title={translate('auto.components.stats.CodexUsagePane.408210470c', 'Codex Usage Tracking')}
        summaryCardCount={6}
        summaryGridClassName="md:grid-cols-3"
      />
    )
  }

  const hasAnyData = summary?.hasAnyCodexData ?? scanState.hasAnyCodexData

  return (
    <div className="space-y-4 rounded-lg border border-border/60 bg-card/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            {translate('auto.components.stats.CodexUsagePane.408210470c', 'Codex Usage Tracking')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatUpdatedAt(scanState.lastScanCompletedAt)}
            {scanState.lastScanError
              ? translate(
                  'auto.components.stats.CodexUsagePane.8a6655f7a2',
                  ' • Last scan error: {{value0}}',
                  { value0: scanState.lastScanError }
                )
              : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          {summary && daily.length > 0 && (
            <ShareUsageButton provider="codex" summary={summary} daily={daily} range={range} />
          )}
          <DropdownMenu>
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={translate(
                        'auto.components.stats.CodexUsagePane.70b5b8581f',
                        'Codex usage options'
                      )}
                    >
                      <SlidersHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.components.stats.CodexUsagePane.1af1a39b2f', 'Filters')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>
                {translate('auto.components.stats.CodexUsagePane.6d68e8399a', 'Scope')}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={scope}
                onValueChange={(value) => void setCodexUsageScope(value as CodexUsageScope)}
              >
                {SCOPE_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                {translate('auto.components.stats.CodexUsagePane.89162e019b', 'Range')}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={range}
                onValueChange={(value) => void setCodexUsageRange(value as CodexUsageRange)}
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
                  onClick={() => void refreshCodexUsage()}
                  disabled={scanState.isScanning}
                  aria-label={translate(
                    'auto.components.stats.CodexUsagePane.ec4d270e2c',
                    'Refresh Codex usage'
                  )}
                >
                  <RefreshCw className={`size-3.5 ${scanState.isScanning ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate('auto.components.stats.CodexUsagePane.3022cda443', 'Refresh')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <button
            type="button"
            role="switch"
            aria-checked={true}
            aria-label={translate(
              'auto.components.stats.CodexUsagePane.f7c1affbd5',
              'Enable Codex usage analytics'
            )}
            onClick={() => handleSetEnabled(false)}
            className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-foreground transition-colors"
          >
            <span className="pointer-events-none block size-3.5 translate-x-4 rounded-full bg-background shadow-sm transition-transform" />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.label} • {RANGE_LABELS[range]}
        </p>
      </div>

      {!hasAnyData ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.stats.CodexUsagePane.4c865393b4',
            'No local Codex usage found yet for this scope.'
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <StatCard
              label={translate('auto.components.stats.CodexUsagePane.e365eaa6fd', 'Input tokens')}
              value={formatTokens(summary?.inputTokens ?? 0)}
              icon={<Sparkles className="size-4" />}
            />
            <StatCard
              label={translate('auto.components.stats.CodexUsagePane.5d8eba87bd', 'Output tokens')}
              value={formatTokens(summary?.outputTokens ?? 0)}
              icon={<Activity className="size-4" />}
            />
            <StatCard
              label={translate('auto.components.stats.CodexUsagePane.a9ac0f423a', 'Cached input')}
              value={formatTokens(summary?.cachedInputTokens ?? 0)}
              icon={<DatabaseZap className="size-4" />}
            />
            <StatCard
              label={translate(
                'auto.components.stats.CodexUsagePane.6e18146e9b',
                'Reasoning output'
              )}
              value={formatTokens(summary?.reasoningOutputTokens ?? 0)}
              icon={<Brain className="size-4" />}
            />
            <StatCard
              label={translate(
                'auto.components.stats.CodexUsagePane.907b31865f',
                'Sessions / Events'
              )}
              value={`${(summary?.sessions ?? 0).toLocaleString()} / ${(summary?.events ?? 0).toLocaleString()}`}
              icon={<FolderKanban className="size-4" />}
            />
            <StatCard
              label={translate(
                'auto.components.stats.CodexUsagePane.1a18fbd56b',
                'Est. API-equivalent cost'
              )}
              value={formatCost(summary?.estimatedCostUsd ?? null)}
              icon={<Coins className="size-4" />}
            />
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.stats.CodexUsagePane.94ac1f1ee7',
              'Reasoning tokens are shown for visibility, but cost is calculated from uncached input, cached input, and output only.'
            )}
          </p>

          <CodexUsageDetails
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
