import { getIntlLocale, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function formatTokens(value: number, intlLocale: string = getIntlLocale()): string {
  if (intlLocale.startsWith('ru')) {
    return new Intl.NumberFormat(intlLocale, {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(value)
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString(intlLocale)
}

export function formatCost(
  value: number | null,
  t: Translate = translate,
  intlLocale: string = getIntlLocale()
): string {
  if (value === null) {
    return t('stats.usage.format.notAvailable', 'n/a')
  }
  const locale = intlLocale
  if (locale.startsWith('ru')) {
    const digits = value < 0.01 ? 4 : 2
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(value)
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

export function formatUsageDayLabel(
  day: string,
  includeYear = false,
  intlLocale: string = getIntlLocale()
): string {
  const parsed = new Date(`${day}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return day
  }
  return parsed.toLocaleDateString(intlLocale, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? ({ year: 'numeric' } as const) : {})
  })
}
