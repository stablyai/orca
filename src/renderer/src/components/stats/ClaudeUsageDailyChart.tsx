import type { ClaudeUsageDailyPoint } from '../../../../shared/agent-usage/analytics/claude-usage-types'
import { useTranslate } from '@/i18n/use-translate'
import { UsageDailyTokenChart } from './UsageDailyTokenChart'

type ClaudeUsageDailyChartProps = {
  daily: ClaudeUsageDailyPoint[]
}

export function ClaudeUsageDailyChart({ daily }: ClaudeUsageDailyChartProps): React.JSX.Element {
  const t = useTranslate()

  return (
    <UsageDailyTokenChart
      title={t('auto.components.stats.ClaudeUsageDailyChart.c9f7cd30e9', 'Daily usage')}
      description={t(
        'auto.components.stats.ClaudeUsageDailyChart.059945f71d',
        'Input, output, cache read, and cache write totals by day.'
      )}
      tokensLabel={t('auto.components.stats.ClaudeUsageDailyChart.a7902d3c1d', 'tokens')}
      daily={daily}
      firstSeriesAt="bottom"
      total={(entry) =>
        entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
      }
      series={[
        {
          key: 'input',
          label: t('auto.components.stats.ClaudeUsageDailyChart.d7fb787e6b', 'Input'),
          value: (entry) => entry.inputTokens,
          className: 'bg-sky-500/80'
        },
        {
          key: 'output',
          label: t('auto.components.stats.ClaudeUsageDailyChart.7d2efeff5e', 'Output'),
          value: (entry) => entry.outputTokens,
          className: 'bg-emerald-500/80'
        },
        {
          key: 'cache-read',
          label: t('auto.components.stats.ClaudeUsageDailyChart.61c58f8976', 'Cache read'),
          value: (entry) => entry.cacheReadTokens,
          className: 'bg-amber-500/70'
        },
        {
          key: 'cache-write',
          label: t('auto.components.stats.ClaudeUsageDailyChart.2a6360c7cb', 'Cache write'),
          value: (entry) => entry.cacheWriteTokens,
          className: 'bg-fuchsia-500/70'
        }
      ]}
    />
  )
}
