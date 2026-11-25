import type { CodexUsageDailyPoint } from '../../../../shared/agent-usage/analytics/codex-usage-types'
import { useTranslate } from '@/i18n/use-translate'
import { UsageDailyTokenChart } from './UsageDailyTokenChart'

type CodexUsageDailyChartProps = {
  daily: CodexUsageDailyPoint[]
  // Codex and Muse count reasoning inside output; OpenCode reports it separately.
  reasoningIncludedInOutput?: boolean
}

export function CodexUsageDailyChart({
  daily,
  reasoningIncludedInOutput = false
}: CodexUsageDailyChartProps): React.JSX.Element {
  const t = useTranslate()

  return (
    <UsageDailyTokenChart
      title={t('auto.components.stats.CodexUsageDailyChart.609aa96e8b', 'Daily usage')}
      description={t(
        'auto.components.stats.CodexUsageDailyChart.c756cda6a8',
        'Input, cached input, output, and reasoning totals by day.'
      )}
      tokensLabel={t('auto.components.stats.CodexUsageDailyChart.e4bdcf0071', 'tokens')}
      daily={daily}
      firstSeriesAt="top"
      total={(entry) => entry.totalTokens}
      series={[
        {
          key: 'input',
          label: t('auto.components.stats.CodexUsageDailyChart.99a91d3143', 'Input'),
          value: (entry) => Math.max(0, entry.inputTokens - entry.cachedInputTokens),
          className: 'bg-sky-500/80'
        },
        {
          key: 'output',
          label: t('auto.components.stats.CodexUsageDailyChart.7b596a88b2', 'Output'),
          value: (entry) =>
            reasoningIncludedInOutput
              ? Math.max(0, entry.outputTokens - entry.reasoningOutputTokens)
              : entry.outputTokens,
          tooltipValue: (entry) => entry.outputTokens,
          className: 'bg-emerald-500/80'
        },
        {
          key: 'cached-input',
          label: t('auto.components.stats.CodexUsageDailyChart.c646e1783c', 'Cached input'),
          value: (entry) => entry.cachedInputTokens,
          className: 'bg-amber-500/70'
        },
        {
          key: 'reasoning',
          label: t('auto.components.stats.CodexUsageDailyChart.1e6f62d7e3', 'Reasoning'),
          value: (entry) => entry.reasoningOutputTokens,
          className: 'bg-fuchsia-500/70'
        }
      ]}
    />
  )
}
