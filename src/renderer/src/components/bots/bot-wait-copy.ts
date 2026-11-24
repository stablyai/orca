// How a bot's waits read: their time and deadline.
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { AutomationOnce } from '../../../../shared/automation-once'
import { botWaitTimeFormat } from '../../../../shared/bots/bot-row-line'

/** "2:14 AM" today, "Fri 5 PM" within the week, "Nov 14, 5 PM" further; minutes only off the hour. */
export function formatWaitTime(at: number, now = Date.now()): string {
  return uiDateTimeFormat(botWaitTimeFormat(at, now)).format(at)
}

/** The sidebar's line: "Until Fri 5 PM", or "No deadline". */
export function waitRowDetail(once: AutomationOnce, now = Date.now()): string {
  return once.by === undefined
    ? translate('bots.waits.noDeadline', 'No deadline')
    : translate('bots.waits.until', 'Until {{time}}', {
        time: formatWaitTime(once.by, now)
      })
}
