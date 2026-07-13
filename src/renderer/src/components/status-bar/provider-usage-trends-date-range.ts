import { i18n } from '@/i18n/i18n'
import { formatLocalDayKey, listRecentLocalDays } from './provider-usage-trends-model'

export function getDefaultCustomStartDay(): string {
  return listRecentLocalDays(30)[0] ?? formatLocalDayKey(new Date())
}

export function getTodayDayKey(): string {
  return formatLocalDayKey(new Date())
}

export function formatUsageTrendsRangeCaption(startDay: string, endDay: string): string {
  const format = (day: string): string =>
    new Date(`${day}T12:00:00`).toLocaleDateString(i18n.language, {
      month: 'short',
      day: 'numeric',
      year: startDay.slice(0, 4) === endDay.slice(0, 4) ? undefined : 'numeric'
    })
  return `${format(startDay)} – ${format(endDay)}`
}
