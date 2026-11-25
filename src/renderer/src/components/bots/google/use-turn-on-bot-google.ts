import { useCallback } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botAskerKeys,
  botOtherAskers,
  googleWhoCanAskWarning
} from '../../../../../shared/google/google-who-can-ask-warning'
import { botErrorMessage } from '../bot-presentation'
import { setBotGoogle, type GoogleBotRead } from './set-bot-google'
import type { BotOnHost } from '@/lib/bot-hosts'

/**
 * Turning Google on lets everyone in the bot's Who can ask use the owner's Google through it, so it
 * is confirmed first when anyone besides the owner can ask. Resolves whether to go ahead.
 */
export function useTurnOnBotGoogle(): (
  bot: Pick<Bot, 'id' | 'name' | 'members'> & BotOnHost,
  /** Only these accounts; absent is every account. */
  accounts?: readonly string[],
  /** The bot's Google as the caller read it: the host refuses the save if it changed meanwhile. */
  basedOn?: GoogleBotRead
) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    async (bot, accounts, basedOn) => {
      const warning = googleWhoCanAskWarning(bot.name, botOtherAskers(bot))
      // The askers the warning named: the host keeps Google off if Who can ask changed meanwhile.
      const confirmedAskers = botAskerKeys(bot)
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
        await setBotGoogle(bot, true, {
          ...(accounts ? { accounts } : {}),
          confirmedAskers,
          ...(basedOn ? { basedOn } : {})
        })
        return true
      } catch (error) {
        toast.error(botErrorMessage(error))
        return false
      }
    },
    [confirm]
  )
}
