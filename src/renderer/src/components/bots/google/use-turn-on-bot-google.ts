import { useCallback } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botOtherAskers,
  googleWhoCanAskWarning
} from '../../../../../shared/google/google-who-can-ask-warning'
import { botErrorMessage } from '../bot-presentation'
import { setBotGoogle } from './google-connect-client'
import type { BotOnHost } from '@/lib/bot-hosts'

/**
 * Turning Google on lets everyone in the bot's Who can ask use the owner's Google through it, so it
 * is confirmed first when anyone besides the owner can ask. Resolves whether to go ahead.
 */
export function useTurnOnBotGoogle(): (
  bot: Pick<Bot, 'id' | 'name' | 'members'> & BotOnHost
) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    async (bot) => {
      const warning = googleWhoCanAskWarning(bot.name, botOtherAskers(bot))
      if (
        warning &&
        !(await confirm({
          surface: 'security',
          title: translate('bots.google.turnOn.title', 'Turn on Google for {{name}}?', {
            name: bot.name
          }),
          description: warning,
          confirmLabel: translate('bots.google.turnOn.confirm', 'Turn on'),
          confirmVariant: 'destructive'
        }))
      ) {
        return false
      }
      try {
        await setBotGoogle(bot, true)
        return true
      } catch (error) {
        toast.error(botErrorMessage(error))
        return false
      }
    },
    [confirm]
  )
}
