import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'

// Intl formatter caches key on option identity, so this must be a module constant.
const UPDATE_DELAY_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric'
}

export function getUpdateDelayTitle(): string {
  return translate('settings.updateDelay.title', 'Update Delay')
}

export function getUpdateDelayDescription(): string {
  return translate(
    'settings.updateDelay.description',
    'Wait this many days after a release is published before Orca offers it, giving time for broken or compromised releases to be pulled.'
  )
}

export function formatUpdateDelayDate(timestamp: number): string {
  return uiDateTimeFormat(UPDATE_DELAY_DATE_FORMAT).format(timestamp)
}
