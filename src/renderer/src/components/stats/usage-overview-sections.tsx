import { AlertCircle } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { formatUsageCost, formatUsageTokens } from './usage-overview-model'
import type {
  UsageOverviewDailyPoint,
  UsageOverviewModel,
  UsageProviderOverview
} from './usage-overview-types'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'

const INTENSITY_CLASS: Record<UsageOverviewDailyPoint['intensity'], string> = {
  0: 'border-border/60 bg-muted/40',
  1: 'border-border/60 bg-muted-foreground/20',
  2: 'border-border/60 bg-muted-foreground/35',
  3: 'border-border/60 bg-muted-foreground/55',
  4: 'border-border/60 bg-foreground/75'
}

function sessionCountLabel(
  sessions: number,
  t: Translate = translate,
  intlLocale: string = getIntlLocale()
): string {
  return t('auto.components.stats.usage.overview.sections.sessionCount', '{{formatted}} sessions', {
    count: sessions,
    formatted: sessions.toLocaleString(intlLocale),
    defaultValue_one: '{{formatted}} session'
  })
}

function activityCountLabel(
  provider: UsageProviderOverview,
  t: Translate = translate,
  intlLocale: string = getIntlLocale()
): string {
  const count = provider.activityCount
  if (provider.activityLabel === 'turns') {
    return t('auto.components.stats.usage.overview.sections.turnCount', '{{formatted}} turns', {
      count,
      formatted: count.toLocaleString(intlLocale),
      defaultValue_one: '{{formatted}} turn'
    })
  }
  return t('auto.components.stats.usage.overview.sections.eventCount', '{{formatted}} events', {
    count,
    formatted: count.toLocaleString(intlLocale),
    defaultValue_one: '{{formatted}} event'
  })
}

function providerSessionsSummary(
  provider: UsageProviderOverview,
  t: Translate = translate,
  intlLocale?: string
): string {
  return t(
    'auto.components.stats.usage.overview.sections.sessionsAndActivity',
    '{{sessions}} - {{activity}}',
    {
      sessions: sessionCountLabel(provider.sessions, t, intlLocale),
      activity: activityCountLabel(provider, t, intlLocale)
    }
  )
}

function formatDayLabel(day: string, intlLocale: string = getIntlLocale()): string {
  const parsed = new Date(`${day}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return day
  }
  return parsed.toLocaleDateString(intlLocale, {
    month: 'short',
    day: 'numeric'
  })
}

export function TokenMixBar({ overview }: { overview: UsageOverviewModel }): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const segments = [
    {
      key: 'new-input',
      label: t('auto.components.stats.usage.overview.sections.9365b14a4e', 'New input'),
      value: overview.newInputTokens,
      className: 'bg-foreground'
    },
    {
      key: 'output',
      label: t('auto.components.stats.usage.overview.sections.7f270458af', 'Output'),
      value: overview.outputTokens,
      className: 'bg-muted-foreground'
    },
    {
      key: 'cache',
      label: t('auto.components.stats.usage.overview.sections.0015facc1f', 'Cache'),
      value: overview.cacheTokens,
      className: 'bg-border'
    }
  ]
  // Codex cached input is already part of input; use normalized new/cache buckets to avoid double-counting.
  const mixTotal = segments.reduce((sum, segment) => sum + segment.value, 0)

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {t('auto.components.stats.usage.overview.sections.4ff104da47', 'Token mix')}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.stats.usage.overview.sections.3bc4a01b24',
              'Combined input, output, and cache tokens across enabled providers.'
            )}
          </p>
        </div>
        {overview.reasoningTokens > 0 ? (
          <Badge variant="outline" className="shrink-0">
            {formatUsageTokens(overview.reasoningTokens, intlLocale)}{' '}
            {t('auto.components.stats.usage.overview.sections.e65084cb4b', 'reasoning')}
          </Badge>
        ) : null}
      </div>

      {mixTotal > 0 ? (
        <div
          className="flex h-3 overflow-hidden rounded-full border border-border/60 bg-muted"
          aria-label={t(
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
                aria-label={t(
                  'auto.components.stats.usage.overview.sections.32330a6e66',
                  '{{value0}}: {{value1}} tokens',
                  {
                    value0: segment.label,
                    value1: segment.value.toLocaleString(intlLocale)
                  }
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
              {segment.label}: {formatUsageTokens(segment.value, intlLocale)}
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
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {t('auto.components.stats.usage.overview.sections.69e2b50427', 'Daily intensity')}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.stats.usage.overview.sections.recentCombinedActivity',
              'Recent combined Claude, Codex, OpenCode, and Muse token activity.'
            )}
          </p>
        </div>
        {bestDay && bestDay.totalTokens > 0 ? (
          <Badge variant="outline" className="shrink-0">
            {t('auto.components.stats.usage.overview.sections.c424eb3f8e', 'Best:')}
            {formatDayLabel(bestDay.day, intlLocale)}
          </Badge>
        ) : null}
      </div>

      <div
        className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(21,minmax(0,1fr))]"
        aria-label={t(
          'auto.components.stats.usage.overview.sections.52d9221dc0',
          'Recent token activity heatmap'
        )}
      >
        {days.map((day) => (
          <div
            key={day.day}
            className={`aspect-square min-h-3 rounded-[2px] border ${INTENSITY_CLASS[day.intensity]}`}
            aria-label={t(
              'auto.components.stats.usage.overview.sections.32330a6e66',
              '{{value0}}: {{value1}} tokens',
              { value0: day.day, value1: day.totalTokens.toLocaleString(intlLocale) }
            )}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{formatDayLabel(days[0]?.day ?? '', intlLocale)}</span>
        <span>{t('auto.components.stats.usage.overview.sections.1dd166c920', 'Less')}</span>
        <div className="flex items-center gap-1" aria-hidden>
          {[0, 1, 2, 3, 4].map((intensity) => (
            <span
              key={intensity}
              className={`size-2 rounded-[2px] border ${INTENSITY_CLASS[intensity as UsageOverviewDailyPoint['intensity']]}`}
            />
          ))}
        </div>
        <span>{t('auto.components.stats.usage.overview.sections.f6df0d7d6d', 'More')}</span>
        <span>{formatDayLabel(days.at(-1)?.day ?? '', intlLocale)}</span>
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
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const share = totalTokens > 0 ? provider.totalTokens / totalTokens : 0
  const status = provider.enabled
    ? provider.isScanning
      ? t('auto.components.stats.usage.overview.sections.statusScanning', 'Scanning')
      : t('auto.components.stats.usage.overview.sections.statusEnabled', 'Enabled')
    : t('auto.components.stats.usage.overview.sections.statusOff', 'Off')
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
              t('auto.components.stats.usage.overview.sections.3de9bf87fc', 'No model yet')}
            {provider.topProject ? ` - ${provider.topProject}` : ''}
          </p>
        </div>
        {!provider.enabled ? (
          <Button variant="outline" size="xs" onClick={onEnable}>
            {t('auto.components.stats.usage.overview.sections.57d1448ef8', 'Enable')}
          </Button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <span>
          {t('auto.components.stats.usage.overview.sections.tokenTotal', '{{tokens}} tokens', {
            tokens: formatUsageTokens(provider.totalTokens, intlLocale)
          })}
        </span>
        <span>{providerSessionsSummary(provider, t, intlLocale)}</span>
        <span>{formatUsageCost(provider.estimatedCostUsd)}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/75"
          style={{
            width: `${Math.max(share * 100, provider.totalTokens > 0 ? 2 : 0)}%`
          }}
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
