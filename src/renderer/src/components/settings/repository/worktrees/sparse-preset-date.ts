import { getIntlLocale } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
const PRESET_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }

export function formatSparsePresetUpdatedAt(
  timestamp: number,
  intlLocale: string = getIntlLocale()
): string | null {
  if (!Number.isFinite(timestamp)) {
    return null
  }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return uiDateTimeFormat(PRESET_DAY, intlLocale).format(date)
}
