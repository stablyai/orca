import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'

export function formatRelativeTime(input: string): string {
  return formatUiRelativeTimeFromDate(input)
}
