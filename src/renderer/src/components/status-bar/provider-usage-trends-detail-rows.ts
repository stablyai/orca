import { translate } from '@/i18n/i18n'
import type { UsageTrendsBucket } from './provider-usage-trends-model'

type ExtraRowsKind = 'claude' | 'reasoning' | 'gemini' | 'kimi'
type ExtraRow = {
  label: string
  key: keyof Pick<
    UsageTrendsBucket,
    'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningOutputTokens' | 'toolTokens'
  >
}

export function getUsageTrendDetailRows(kind: ExtraRowsKind): ExtraRow[] {
  if (kind === 'claude' || kind === 'kimi') {
    return [
      row(
        'cacheReadTokens',
        'auto.components.status.bar.ProviderUsageTrendsChart.cacheRead',
        'Cache read'
      ),
      row(
        'cacheWriteTokens',
        'auto.components.status.bar.ProviderUsageTrendsChart.cacheWrite',
        'Cache write'
      )
    ]
  }
  if (kind === 'gemini') {
    return [
      row(
        'cacheReadTokens',
        'auto.components.status.bar.ProviderUsageTrendsChart.cachedInput',
        'Cached input'
      ),
      row(
        'reasoningOutputTokens',
        'auto.components.status.bar.ProviderUsageTrendsChart.reasoning',
        'Reasoning'
      ),
      row('toolTokens', 'auto.components.status.bar.ProviderUsageTrendsChart.tool', 'Tool')
    ]
  }
  return [
    row(
      'cacheReadTokens',
      'auto.components.status.bar.ProviderUsageTrendsChart.cachedInput',
      'Cached input'
    ),
    row(
      'reasoningOutputTokens',
      'auto.components.status.bar.ProviderUsageTrendsChart.reasoning',
      'Reasoning'
    )
  ]
}

function row(key: ExtraRow['key'], translationKey: string, fallback: string): ExtraRow {
  return { key, label: translate(translationKey, fallback) }
}
