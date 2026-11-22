import { translate } from '@/i18n/i18n'
import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'

/** The chat a bot automation runs in when it names one, by the title saved with it. */
export function botTargetChatTitle(chat: NonNullable<AutomationBotTarget['chat']>): string {
  return chat.title || translate('automations.botTarget.runsInUntitledChat', 'An untitled chat')
}
