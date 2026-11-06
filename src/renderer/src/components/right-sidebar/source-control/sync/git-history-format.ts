import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
// Include the zone to distinguish repeated times when clocks fall back.
const GIT_HISTORY_TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'long'
}

export function formatGitHistoryTimestamp(timestamp: number | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return ''
  }
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return uiDateTimeFormat(GIT_HISTORY_TIMESTAMP_OPTIONS).format(date)
}
