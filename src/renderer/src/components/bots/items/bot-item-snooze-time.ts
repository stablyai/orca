import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { botItemSnoozeTimeFormat } from '../../../../../shared/bots/bot-item-snooze'

/** A wake time as rows and menus say it: "6:00 PM", "Thu 9:00 AM" or "Nov 30, 9:00 AM". */
export function formatBotItemSnoozeTime(until: number, now: number): string {
  return uiDateTimeFormat(botItemSnoozeTimeFormat(until, now)).format(until)
}
