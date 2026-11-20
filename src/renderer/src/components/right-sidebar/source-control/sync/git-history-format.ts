import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
// Include the zone to distinguish repeated times when clocks fall back.
const GIT_HISTORY_TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'long'
}
// For the Git Graph's narrow date column; the row title keeps the full form.
const GIT_HISTORY_COMPACT_TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: 'short',
  timeStyle: 'short'
}

export function formatGitHistoryTimestamp(
  timestamp: number | undefined,
  intlLocale?: string,
  length: 'full' | 'compact' = 'full'
): string {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return ''
  }
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const options =
    length === 'compact' ? GIT_HISTORY_COMPACT_TIMESTAMP_OPTIONS : GIT_HISTORY_TIMESTAMP_OPTIONS
  return uiDateTimeFormat(options, intlLocale).format(date)
}
