import { AlertCircle } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  formatUsageCost,
  formatUsageTokens,
  type UsageOverviewDailyPoint,
  type UsageOverviewModel,
  type UsageProviderOverview
} from './usage-overview-model'
import { translate } from '@/i18n/i18n'

const INTENSITY_CLASS: Record<UsageOverviewDailyPoint['intensity'], string> = {
  0: 'border-border/60 bg-muted/40',
  1: 'border-border/60 bg-muted-foreground/20',
  2: 'border-border/60 bg-muted-foreground/35',
  3: 'border-border/60 bg-muted-foreground/55',
  4: 'border-border/60 bg-foreground/75'
}

function translateActivityLabel(label: UsageProviderOverview['activityLabel']): string {
  if (label === 'turns') {
    return translate('auto.components.stats.usage.overview.sections.c8f3a2d1e0b4', 'turns')
  }
  return translate('auto.components.stats.usage.overview.sections.d9a4b3e2f1c5', 'events')
}

function formatDayLabel(day: string): string {
  const parsed = new Date(`${day}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return day
  }
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function TokenMixBar({ overview }: { overview: UsageOverviewModel }): React.JSX.Element {
  const segments = [
    {
      key: 'new-input',
      label: translate('auto.components.stats.usage.overview.sections.9365b14a4e', 'New input'),
      value: overview.newInputTokens,
      className: 'bg-foreground'
    },
    {
      key: 'output',
      label: translate('auto.components.stats.usage.overview.sections.7f270458af', 'Output'),
      value: overview.outputTokens,
      className: 'bg-muted-foreground'
    },
    {
      key: 'cache',
      label: translate('auto.components.stats.usage.overview.sections.0015facc1f', 'Cache'),
      value: overview.cacheTokens,
      className: 'bg-border'
    }
  ]
  // Why: Codex cached input is a subset of input. The overview model normalizes
  // that into new/cache buckets so the visual mix does not double-count it.
  const mixTotal = segments.reduce((sum, segment) => sum + segment.value, 0)

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {translate('auto.components.stats.usage.overview.sections.4ff104da47', 'Token mix')}
          </h4>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.stats.usage.overview.sections.3bc4a01b24',
              'Combined input, output, and cache tokens across enabled providers.'
            )}
          </p>
        </div>
        {overview.reasoningTokens > 0 ? (
          <Badge variant="outline" className="shrink-0">
            {formatUsageTokens(overview.reasoningTokens)}{' '}
            {translate('auto.components.stats.usage.overview.sections.e65084cb4b', 'reasoning')}
          </Badge>
        ) : null}
      </div>

      {mixTotal > 0 ? (
        <div
          className="flex h-3 overflow-hidden rounded-full border border-border/60 bg-muted"
          aria-label={translate(
            'auto.components.stats.usage.overview.sections.3a795542fa',
            'Combined token mix'
          )}
        >
          {segments.map((segment) =>
            segment.value > 0 ? (
              <div
                key={segment.key}
                className={segment.className}
                style={{ width: `${(segment.value / mixTotal) * 100}%` }}
                aria-label={translate(
                  'auto.components.stats.usage.overview.sections.32330a6e66',
                  '{{value0}}: {{value1}} tokens',
                  { value0: segment.label, value1: segment.value.toLocaleString() }
                )}
              />
            ) : null
          )}
        </div>
      ) : (
        <div className="h-3 rounded-full border border-dashed border-border/60 bg-muted/40" />
      )}

      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        {segments.map((segment) => (
          <div key={segment.key} className="flex min-w-0 items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${segment.className}`} />
            <span className="min-w-0 truncate">
              {segment.label}: {formatUsageTokens(segment.value)}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

export function DailyIntensityGrid({
  days,
  bestDay
}: {
  days: UsageOverviewDailyPoint[]
  bestDay: UsageOverviewDailyPoint | null
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {translate(
              'auto.components.stats.usage.overview.sections.69e2b50427',
              'Daily intensity'
            )}
          </h4>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.stats.usage.overview.sections.f28ff1f852',
              'Recent combined Claude, Codex, and OpenCode token activity.'
            )}
          </p>
        </div>
        {bestDay && bestDay.totalTokens > 0 ? (
          <Badge variant="outline" className="shrink-0">
            {translate('auto.components.stats.usage.overview.sections.c424eb3f8e', 'Best:')}
            {formatDayLabel(bestDay.day)}
          </Badge>
        ) : null}
      </div>

      <div
        className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(21,minmax(0,1fr))]"
        aria-label={translate(
          'auto.components.stats.usage.overview.sections.52d9221dc0',
          'Recent token activity heatmap'
        )}
      >
        {days.map((day) => (
          <div
            key={day.day}
            className={`aspect-square min-h-3 rounded-[2px] border ${INTENSITY_CLASS[day.intensity]}`}
            aria-label={translate(
              'auto.components.stats.usage.overview.sections.32330a6e66',
              '{{value0}}: {{value1}} tokens',
              { value0: day.day, value1: day.totalTokens.toLocaleString() }
            )}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{formatDayLabel(days[0]?.day ?? '')}</span>
        <span>{translate('auto.components.stats.usage.overview.sections.1dd166c920', 'Less')}</span>
        <div className="flex items-center gap-1" aria-hidden>
          {[0, 1, 2, 3, 4].map((intensity) => (
            <span
              key={intensity}
              className={`size-2 rounded-[2px] border ${INTENSITY_CLASS[intensity as UsageOverviewDailyPoint['intensity']]}`}
            />
          ))}
        </div>
        <span>{translate('auto.components.stats.usage.overview.sections.f6df0d7d6d', 'More')}</span>
        <span>{formatDayLabel(days.at(-1)?.day ?? '')}</span>
      </div>
    </section>
  )
}

export function ProviderUsageRow({
  provider,
  totalTokens,
  onEnable
}: {
  provider: UsageProviderOverview
  totalTokens: number
  onEnable: () => void
}): React.JSX.Element {
  const share = totalTokens > 0 ? provider.totalTokens / totalTokens : 0
  const status = provider.enabled ? (provider.isScanning ? 'Scanning' : 'Enabled') : 'Off'
  const statusVariant = provider.enabled ? 'secondary' : 'outline'

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h5 className="truncate text-sm font-semibold text-foreground">{provider.label}</h5>
            <Badge variant={statusVariant}>{status}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {provider.topModel ??
              translate('auto.components.stats.usage.overview.sections.3de9bf87fc', 'No model yet')}
            {provider.topProject ? ` - ${provider.topProject}` : ''}
          </p>
        </div>
        {!provider.enabled ? (
          <Button variant="outline" size="xs" onClick={onEnable}>
            {translate('auto.components.stats.usage.overview.sections.57d1448ef8', 'Enable')}
          </Button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <span>
          {formatUsageTokens(provider.totalTokens)}{' '}
          {translate('auto.components.stats.usage.overview.sections.6762f6a682', 'tokens')}
        </span>
        <span>
          {translate(
            'auto.components.stats.usage.overview.sections.a7f937fb29',
            '{{value0}} sessions - {{value1}} {{value2}}',
            {
              value0: provider.sessions.toLocaleString(),
              value1: provider.activityCount.toLocaleString(),
              value2: translateActivityLabel(provider.activityLabel)
            }
          )}
        </span>
        <span>{formatUsageCost(provider.estimatedCostUsd)}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/75"
          style={{ width: `${Math.max(share * 100, provider.totalTokens > 0 ? 2 : 0)}%` }}
        />
      </div>
      {provider.lastScanError ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="size-3" />
          {provider.lastScanError}
        </p>
      ) : null}
    </div>
  )
}
