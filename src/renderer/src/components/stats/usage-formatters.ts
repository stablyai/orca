import { i18n, translate } from '@/i18n/i18n'

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString(resolveUiLocaleTag())
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

export function formatUpdatedAt(timestamp: number | null): string {
  if (!timestamp) {
    return translate('auto.components.stats.usage.notScannedYet', 'Not scanned yet')
  }
  return translate('auto.components.stats.usage.updatedAt', 'Updated {{when}}', {
    when: new Date(timestamp).toLocaleString(resolveUiLocaleTag())
  })
}

export function formatUnknownLocationLabel(label: string): string {
  if (label === 'Unknown location') {
    return translate('auto.components.stats.usage.unknownLocation', 'Unknown location')
  }
  return label
}

export function formatUsageProjectLabel(label: string): string {
  return formatUnknownLocationLabel(label)
}

export function formatSessionTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }
  return parsed.toLocaleString(resolveUiLocaleTag(), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function resolveUiLocaleTag(): string | undefined {
  const language = i18n.language
  if (language === 'zh') {
    return 'zh-CN'
  }
  if (language === 'ja') {
    return 'ja-JP'
  }
  if (language === 'ko') {
    return 'ko-KR'
  }
  if (language === 'es') {
    return 'es'
  }
  return undefined
}
