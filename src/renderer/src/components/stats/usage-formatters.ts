import { getIntlLocale, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function formatTokens(value: number, intlLocale: string = getIntlLocale()): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString(intlLocale)
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

export function formatUpdatedAt(
  timestamp: number | null,
  t: Translate = translate,
  intlLocale: string = getIntlLocale()
): string {
  if (!timestamp) {
    return t('auto.components.stats.usageFormatters.notScannedYet', 'Not scanned yet')
  }
  return t('auto.components.stats.usageFormatters.updatedAt', 'Updated {{time}}', {
    time: new Date(timestamp).toLocaleString(intlLocale)
  })
}

export function formatUnknownLocationLabel(label: string): string {
  if (label === 'Unknown location') {
    return translate('auto.components.stats.usageFormatters.unknownLocation', 'Unknown location')
  }
  return label
}

export function formatUsageProjectLabel(label: string): string {
  return formatUnknownLocationLabel(label)
}

export function formatSessionTime(timestamp: string, intlLocale: string = getIntlLocale()): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }
  return parsed.toLocaleString(intlLocale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
