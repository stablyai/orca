import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { BotItemStatus } from '../../../../../shared/bots/bot-items'
import { botItemStatusName } from '../../../../../shared/bots/bot-item-status-name'

export { botItemStatusName }

export function useBotItemStatusName(): (status: BotItemStatus) => string {
  const t = useTranslate()
  return (status) => botItemStatusName(status, t)
}

/** A status as a picker offers it: the ones that ask for a line first end in an ellipsis. */
export function botItemPickName(status: BotItemStatus, t: Translate): string {
  return status === 'canceled'
    ? t('bots.items.menu.canceled', 'Canceled…')
    : status === 'waiting'
      ? t('bots.items.menu.waiting', 'Waiting…')
      : botItemStatusName(status, t)
}
