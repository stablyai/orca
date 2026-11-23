import { useTranslate } from '@/i18n/use-translate'
import type { BotItemStatus } from '../../../../../shared/bots/bot-items'
import { botItemStatusName } from '../../../../../shared/bots/bot-item-status-name'

export { botItemStatusName }

export function useBotItemStatusName(): (status: BotItemStatus) => string {
  const t = useTranslate()
  return (status) => botItemStatusName(status, t)
}
