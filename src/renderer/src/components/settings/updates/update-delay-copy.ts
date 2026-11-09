import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'

// Intl formatter caches key on option identity, so this must be a module constant.
const UPDATE_DELAY_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric'
}

export function getUpdateDelayTitle(t: Translate = translate): string {
  return t('settings.updateDelay.title', 'Update Delay')
}

export function getUpdateDelayDescription(t: Translate = translate): string {
  return t(
    'settings.updateDelay.description',
    'Wait this many days after a release is published before Orca offers it.'
  )
}

export function formatUpdateDelayDate(timestamp: number, intlLocale?: string): string {
  return uiDateTimeFormat(UPDATE_DELAY_DATE_FORMAT, intlLocale).format(timestamp)
}
