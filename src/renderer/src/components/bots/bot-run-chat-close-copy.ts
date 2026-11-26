import type { Translate } from '@/i18n/use-translate'
import type { BotRunChatCloseAfter } from '../../../../shared/bots/bot-run-chat-close'

/** A Close after choice as both Settings selects name it. */
export function botRunChatCloseLabel(choice: BotRunChatCloseAfter, t: Translate): string {
  switch (choice) {
    case '24h':
      return t('bots.runChatClose.hours24', '24 hours')
    case '7d':
      return t('bots.runChatClose.days7', '7 days')
    case 'never':
      return t('bots.runChatClose.never', 'Never')
  }
}

export function botRunChatCloseTitle(t: Translate): string {
  return t('bots.runChatClose.title', 'Close finished run chats after')
}
