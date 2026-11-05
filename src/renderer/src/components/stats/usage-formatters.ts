import { getIntlLocale, translate } from '@/i18n/i18n'

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString(getIntlLocale())
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

// Why: day keys are calendar days; `new Date('YYYY-MM-DD')` parses as UTC and can shift a day.
export function formatDayKey(day: string, options: Intl.DateTimeFormatOptions): string {
  const parsed = new Date(`${day}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return day
  }
  return parsed.toLocaleDateString(getIntlLocale(), options)
}

export function formatUpdatedAt(timestamp: number | null): string {
  if (!timestamp) {
    return translate('auto.components.stats.usageFormatters.notScannedYet', 'Not scanned yet')
  }
  return translate('auto.components.stats.usageFormatters.updatedAt', 'Updated {{time}}', {
    time: new Date(timestamp).toLocaleString(getIntlLocale())
  })
}

export function formatSessionTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }
  return parsed.toLocaleString(getIntlLocale(), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
